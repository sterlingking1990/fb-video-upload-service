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

app.post('/facebook/upload-video', async (req, res) => {
  try {
    const { video_url, ad_account_id } = req.body;

    if (!video_url || !ad_account_id) {
      return res.status(400).json({ error: 'Missing video_url or ad_account_id' });
    }

    // 1️⃣ Get file size
    const head = await axios.head(video_url);
    const fileSize = parseInt(head.headers['content-length'], 10);

    if (!fileSize || fileSize <= 0) {
      throw new Error('Unable to determine video file size');
    }

    // 2️⃣ Start upload
    const startRes = await axios.post(
      `https://graph.facebook.com/${FACEBOOK_API_VERSION}/act_${ad_account_id}/advideos`,
      {
        upload_phase: 'start',
        file_size: fileSize,
        access_token: FACEBOOK_ACCESS_TOKEN
      }
    );

    let {
      upload_session_id,
      video_id,
      start_offset,
      end_offset
    } = startRes.data;

    // 3️⃣ Stream video
    const videoStream = await axios.get(video_url, { responseType: 'stream' });

    let uploaded = 0;

    for await (const chunk of videoStream.data) {
      if (uploaded.toString() !== start_offset) continue;

      const transferRes = await axios.post(
        `https://graph.facebook.com/${FACEBOOK_API_VERSION}/act_${ad_account_id}/advideos`,
        {
          upload_phase: 'transfer',
          upload_session_id,
          start_offset,
          video_file_chunk: chunk
        },
        {
          headers: {
            'Authorization': `Bearer ${FACEBOOK_ACCESS_TOKEN}`,
            'Content-Type': 'application/octet-stream'
          }
        }
      );

      uploaded += chunk.length;
      start_offset = transferRes.data.start_offset;
      end_offset = transferRes.data.end_offset;
    }

    // 4️⃣ Finish upload
    await axios.post(
      `https://graph.facebook.com/${FACEBOOK_API_VERSION}/act_${ad_account_id}/advideos`,
      {
        upload_phase: 'finish',
        upload_session_id,
        access_token: FACEBOOK_ACCESS_TOKEN
      }
    );

    // 5️⃣ Poll status
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 5000));

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

      if (status === 'ready') {
        return res.json({ video_id });
      }

      if (status === 'error') {
        throw new Error('Facebook failed to process video');
      }
    }

    return res.json({ video_id, warning: 'Video still processing' });

  } catch (error) {
    console.error('Upload failed:', error?.response?.data || error.message);
    res.status(500).json({
      error: 'Video upload failed',
      details: error?.response?.data || error.message
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`FB video upload service running on port ${PORT}`);
});
