import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import FormData from 'form-data';
import { Readable } from 'stream';

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
const CHUNK_SIZE = 1024 * 1024 * 5; // 5MB chunks

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
      const head = await axios.head(video_url, { timeout: 30000 });
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

      console.log(`File size: ${(fileSize / 1024 / 1024).toFixed(1)}MB`);

      // 2️⃣ Start upload session
      const startRes = await axios.post(
        `https://graph.facebook.com/${FACEBOOK_API_VERSION}/${adAccountId}/advideos`,
        {
          upload_phase: 'start',
          file_size: fileSize,
          access_token: FACEBOOK_ACCESS_TOKEN
        }
      );

      const { upload_session_id, video_id, start_offset, end_offset } = startRes.data;
      console.log('Upload session started:', upload_session_id);
      console.log('Initial offset range:', start_offset, '-', end_offset);

      // 3️⃣ Upload in chunks using Range requests
      let currentOffset = parseInt(start_offset);

      while (currentOffset < fileSize) {
        const rangeEnd = Math.min(currentOffset + CHUNK_SIZE - 1, fileSize - 1);
        
        console.log(`Downloading chunk: bytes ${currentOffset}-${rangeEnd} (${((currentOffset / fileSize) * 100).toFixed(1)}%)`);

        // Download this specific chunk
        const chunkResponse = await axios.get(video_url, {
          responseType: 'arraybuffer',
          headers: {
            'Range': `bytes=${currentOffset}-${rangeEnd}`
          },
          timeout: 60000
        });

        const chunkBuffer = Buffer.from(chunkResponse.data);
        
        console.log(`Uploading ${chunkBuffer.length} bytes...`);

        // Upload chunk using multipart/form-data
        const formData = new FormData();
        formData.append('upload_phase', 'transfer');
        formData.append('upload_session_id', upload_session_id);
        formData.append('start_offset', currentOffset.toString());
        formData.append('video_file_chunk', chunkBuffer, {
          filename: 'chunk',
          contentType: 'application/octet-stream'
        });

        const transferRes = await axios.post(
          `https://graph.facebook.com/${FACEBOOK_API_VERSION}/${adAccountId}/advideos`,
          formData,
          {
            params: { access_token: FACEBOOK_ACCESS_TOKEN },
            headers: formData.getHeaders(),
            maxBodyLength: Infinity,
            maxContentLength: Infinity,
            timeout: 120000
          }
        );

        const newStartOffset = parseInt(transferRes.data.start_offset);
        const newEndOffset = parseInt(transferRes.data.end_offset);
        
        console.log(`Chunk uploaded. New offset: ${newStartOffset}-${newEndOffset}`);

        currentOffset = newStartOffset;

        // Throttle to avoid rate limits
        await sleep(1000);
      }

      // 4️⃣ Finish upload
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

      // 5️⃣ Poll status
      for (let i = 0; i < 30; i++) {
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