import 'dotenv/config';
import express from 'express';
import axios from 'axios';

const app = express();
app.use(express.json());

const FACEBOOK_API_VERSION = 'v19.0';
const FACEBOOK_ACCESS_TOKEN = process.env.FACEBOOK_ACCESS_TOKEN;

if (!FACEBOOK_ACCESS_TOKEN) {
  throw new Error('FACEBOOK_ACCESS_TOKEN is required');
}

axios.defaults.timeout = 300_000;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const MAX_VIDEO_SIZE = 250 * 1024 * 1024;
const CHUNK_SIZE = 1024 * 1024 * 4; // 4MB chunks

app.post('/facebook/upload-video', async (req, res) => {
  const { video_url, ad_account_id } = req.body;

  if (!video_url || !ad_account_id) {
    return res.status(400).json({ error: 'Missing video_url or ad_account_id' });
  }

  const adAccountId = `act_${ad_account_id}`;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      console.log(`[Attempt ${attempt}] Uploading video for`, adAccountId);

      // 1️⃣ Get file size
      const head = await axios.head(video_url);
      const fileSize = parseInt(head.headers['content-length'], 10);

      if (!fileSize || fileSize <= 0) {
        throw new Error('Unable to determine video file size');
      }

      if (fileSize > MAX_VIDEO_SIZE) {
        return res.status(400).json({
          error: 'Video too large',
          details: `Max allowed size is 250MB. Got ${(fileSize / 1024 / 1024).toFixed(1)}MB`
        });
      }

      // 2️⃣ Start upload session
      const startRes = await axios.post(
        `https://graph.facebook.com/${FACEBOOK_API_VERSION}/${adAccountId}/advideos`,
        {
          upload_phase: 'start',
          file_size: fileSize,
          access_token: FACEBOOK_ACCESS_TOKEN
        }
      );

      const { upload_session_id, video_id } = startRes.data;
      console.log('Upload session started:', upload_session_id);

      // 3️⃣ Download video to buffer
      console.log('Downloading video...');
      const videoResponse = await axios.get(video_url, {
        responseType: 'arraybuffer',
        timeout: 300_000
      });

      const videoBuffer = Buffer.from(videoResponse.data);
      console.log(`Downloaded ${(videoBuffer.length / 1024 / 1024).toFixed(1)}MB`);

      // 4️⃣ Upload in chunks
      let startOffset = 0;

      while (startOffset < videoBuffer.length) {
        const endOffset = Math.min(startOffset + CHUNK_SIZE, videoBuffer.length);
        const chunk = videoBuffer.slice(startOffset, endOffset);

        console.log(`Uploading chunk: ${startOffset}-${endOffset} (${((endOffset / videoBuffer.length) * 100).toFixed(1)}%)`);

        await axios.post(
          `https://graph.facebook.com/${FACEBOOK_API_VERSION}/${adAccountId}/advideos`,
          {
            upload_phase: 'transfer',
            upload_session_id,
            start_offset: startOffset,
            video_file_chunk: chunk.toString('base64'),
            access_token: FACEBOOK_ACCESS_TOKEN
          },
          { timeout: 120_000 }
        );

        startOffset = endOffset;
        await sleep(500); // Throttle between chunks
      }

      // 5️⃣ Finish upload
      console.log('Finishing upload...');
      await axios.post(
        `https://graph.facebook.com/${FACEBOOK_API_VERSION}/${adAccountId}/advideos`,
        {
          upload_phase: 'finish',
          upload_session_id,
          access_token: FACEBOOK_ACCESS_TOKEN
        }
      );

      console.log('Upload finished, polling status…');

      // 6️⃣ Poll status
      for (let i = 0; i < 20; i++) {
        await sleep(3000);

        const statusRes = await axios.get(
          `https://graph.facebook.com/${FACEBOOK_API_VERSION}/${video_id}`,
          {
            params: {
              fields: 'status',
              access_token: FACEBOOK_ACCESS_TOKEN
            }
          }
        );

        const status = statusRes.data?.status?.video_status;
        console.log(`Status check ${i + 1}:`, status);

        if (status === 'ready') {
          return res.json({ video_id });
        }

        if (status === 'error') {
          throw new Error('Facebook failed to process video');
        }
      }

      return res.json({
        video_id,
        warning: 'Video still processing'
      });

    } catch (error) {
      const fbError = error?.response?.data?.error;
      const isTransient = fbError?.is_transient;

      console.error('Upload attempt failed:', fbError || error.message);

      if (attempt === 2 || !isTransient) {
        return res.status(500).json({
          error: 'Video upload failed',
          details: fbError || error.message
        });
      }

      console.warn('Retrying video upload due to transient error…');
      await sleep(5000);
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`FB video upload service running on port ${PORT}`);
});