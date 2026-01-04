/**
 * KINAFLIX TV - Production Video Management System
 * Secure backend-mediated upload to Bunny Stream
 * Designed for Railway/Fly.io/Koyeb deployment
 */

const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const crypto = require('crypto');
const { CronJob } = require('cron');
const sqlite3 = require('sqlite3').verbose();
require('dotenv').config();

// Initialize Express
const app = express();
const PORT = process.env.PORT || 3000;

// ========== DATABASE SETUP ==========
const db = new sqlite3.Database('./videos.db', (err) => {
  if (err) console.error('Database error:', err);
  else console.log('Connected to SQLite database');
});

// Create videos table
db.run(`
  CREATE TABLE IF NOT EXISTS videos (
    id TEXT PRIMARY KEY,
    bunny_guid TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    filename TEXT NOT NULL,
    file_size INTEGER NOT NULL,
    duration INTEGER,
    resolution TEXT,
    mime_type TEXT,
    upload_date DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_accessed DATETIME DEFAULT CURRENT_TIMESTAMP,
    views INTEGER DEFAULT 0,
    status TEXT DEFAULT 'active',
    metadata TEXT
  )
`);

// Create cleanup logs table
db.run(`
  CREATE TABLE IF NOT EXISTS cleanup_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    videos_deleted INTEGER DEFAULT 0,
    total_size_deleted INTEGER DEFAULT 0,
    error TEXT
  )
`);

// ========== BUNNY STREAM CONFIG ==========
const BUNNY_CONFIG = {
  apiKey: process.env.BUNNY_API_KEY,
  libraryId: process.env.BUNNY_LIBRARY_ID,
  hostname: process.env.BUNNY_HOSTNAME,
  
  // API Endpoints
  endpoints: {
    createVideo: `https://video.bunnycdn.com/library/${process.env.BUNNY_LIBRARY_ID}/videos`,
    uploadVideo: (guid) => `https://video.bunnycdn.com/library/${process.env.BUNNY_LIBRARY_ID}/videos/${guid}`,
    deleteVideo: (guid) => `https://video.bunnycdn.com/library/${process.env.BUNNY_LIBRARY_ID}/videos/${guid}`,
    getVideo: (guid) => `https://video.bunnycdn.com/library/${process.env.BUNNY_LIBRARY_ID}/videos/${guid}`
  }
};

// Validate required environment variables
const requiredEnvVars = ['BUNNY_API_KEY', 'BUNNY_LIBRARY_ID', 'BUNNY_HOSTNAME'];
for (const varName of requiredEnvVars) {
  if (!process.env[varName]) {
    console.error(`❌ MISSING ENV VARIABLE: ${varName}`);
    process.exit(1);
  }
}

// ========== MIDDLEWARE ==========
app.use(cors({
  origin: ['http://localhost:3000', 'https://kinaflix-tv.onrender.com'],
  credentials: true
}));
app.use(express.json());
app.use(express.static(__dirname));

// Temporary upload directory
const UPLOADS_DIR = path.join(__dirname, 'uploads');
fs.mkdir(UPLOADS_DIR, { recursive: true });

// ========== MULTER CONFIGURATION ==========
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOADS_DIR);
  },
  filename: (req, file, cb) => {
    const uniqueName = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${path.extname(file.originalname)}`;
    cb(null, uniqueName);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: parseInt(process.env.MAX_FILE_SIZE_MB || 5120) * 1024 * 1024,
    files: 1
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = [
      'video/mp4', 'video/webm', 'video/quicktime', 
      'video/x-msvideo', 'video/x-matroska', 'video/ogg'
    ];
    
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Invalid file type: ${file.mimetype}. Allowed: ${allowedTypes.join(', ')}`));
    }
  }
});

// ========== HELPER FUNCTIONS ==========

/**
 * Upload file to Bunny Stream via official API
 */
async function uploadToBunnyStream(filePath, videoData) {
  const fetch = (await import('node-fetch')).default;
  
  try {
    console.log('Step 1: Creating video entry in Bunny Stream...');
    
    // 1. Create video entry in Bunny
    const createResponse = await fetch(BUNNY_CONFIG.endpoints.createVideo, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'AccessKey': BUNNY_CONFIG.apiKey
      },
      body: JSON.stringify({
        title: videoData.title || path.basename(filePath),
        collectionId: videoData.collectionId || null
      })
    });
    
    if (!createResponse.ok) {
      throw new Error(`Bunny create failed: ${createResponse.status} ${await createResponse.text()}`);
    }
    
    const bunnyVideo = await createResponse.json();
    console.log(`✅ Video created in Bunny: ${bunnyVideo.guid}`);
    
    // 2. Upload actual video file
    console.log('Step 2: Uploading video file to Bunny...');
    const fileBuffer = await fs.readFile(filePath);
    const fileStats = await fs.stat(filePath);
    
    const uploadResponse = await fetch(BUNNY_CONFIG.endpoints.uploadVideo(bunnyVideo.guid), {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/octet-stream',
        'AccessKey': BUNNY_CONFIG.apiKey
      },
      body: fileBuffer
    });
    
    if (!uploadResponse.ok) {
      // Clean up the created video entry if upload fails
      await fetch(BUNNY_CONFIG.endpoints.deleteVideo(bunnyVideo.guid), {
        method: 'DELETE',
        headers: { 'AccessKey': BUNNY_CONFIG.apiKey }
      }).catch(() => {});
      
      throw new Error(`Bunny upload failed: ${uploadResponse.status} ${await uploadResponse.text()}`);
    }
    
    // 3. Wait for processing to complete
    console.log('Step 3: Waiting for video processing...');
    let isProcessing = true;
    let attempts = 0;
    const maxAttempts = 60; // 5 minutes max wait
    
    while (isProcessing && attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds
      
      const statusResponse = await fetch(BUNNY_CONFIG.endpoints.getVideo(bunnyVideo.guid), {
        headers: { 'AccessKey': BUNNY_CONFIG.apiKey }
      });
      
      if (statusResponse.ok) {
        const status = await statusResponse.json();
        
        if (status.status === 3) { // 3 = Encoding finished
          isProcessing = false;
          console.log(`✅ Video processing complete: ${bunnyVideo.guid}`);
          
          // Return enhanced video info
          return {
            ...bunnyVideo,
            duration: status.length,
            resolution: `${status.width}x${status.height}`,
            thumbnail: `https://${BUNNY_CONFIG.hostname}/${bunnyVideo.guid}/thumbnail.jpg`,
            playbackUrls: {
              hls: `https://${BUNNY_CONFIG.hostname}/${bunnyVideo.guid}/playlist.m3u8`,
              mp4: `https://${BUNNY_CONFIG.hostname}/${bunnyVideo.guid}/play_720p.mp4`,
              iframe: `https://iframe.mediadelivery.net/embed/${BUNNY_CONFIG.libraryId}/${bunnyVideo.guid}`
            }
          };
        } else if (status.status === 4) { // 4 = Error
          throw new Error(`Bunny encoding failed: ${status.encodingErrorMessage || 'Unknown error'}`);
        }
      }
      
      attempts++;
      console.log(`⏳ Processing... attempt ${attempts}/${maxAttempts}`);
    }
    
    if (attempts >= maxAttempts) {
      throw new Error('Video processing timeout');
    }
    
  } catch (error) {
    console.error('Bunny upload error:', error);
    throw error;
  }
}

/**
 * Store video metadata in database
 */
function storeVideoMetadata(videoData) {
  return new Promise((resolve, reject) => {
    const videoId = crypto.randomBytes(16).toString('hex');
    const metadata = {
      bunny_guid: videoData.guid,
      title: videoData.title || videoData.guid,
      filename: videoData.fileName || videoData.guid,
      file_size: videoData.fileSize || 0,
      duration: videoData.duration || 0,
      resolution: videoData.resolution || 'Unknown',
      mime_type: videoData.mimeType || 'video/mp4',
      metadata: JSON.stringify({
        playbackUrls: videoData.playbackUrls,
        thumbnail: videoData.thumbnail,
        uploadDate: new Date().toISOString()
      })
    };
    
    db.run(
      `INSERT INTO videos (id, bunny_guid, title, filename, file_size, duration, resolution, mime_type, metadata) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        videoId,
        metadata.bunny_guid,
        metadata.title,
        metadata.filename,
        metadata.file_size,
        metadata.duration,
        metadata.resolution,
        metadata.mime_type,
        metadata.metadata
      ],
      function(err) {
        if (err) reject(err);
        else resolve({ videoId, ...metadata });
      }
    );
  });
}

/**
 * Delete video from Bunny and database
 */
async function deleteVideoFromSystem(videoId) {
  return new Promise(async (resolve, reject) => {
    try {
      // 1. Get video metadata
      db.get('SELECT bunny_guid, filename FROM videos WHERE id = ?', [videoId], async (err, video) => {
        if (err) return reject(err);
        if (!video) return reject(new Error('Video not found'));
        
        // 2. Delete from Bunny Stream
        const fetch = (await import('node-fetch')).default;
        const deleteResponse = await fetch(BUNNY_CONFIG.endpoints.deleteVideo(video.bunny_guid), {
          method: 'DELETE',
          headers: { 'AccessKey': BUNNY_CONFIG.apiKey }
        });
        
        if (!deleteResponse.ok && deleteResponse.status !== 404) {
          return reject(new Error(`Bunny delete failed: ${deleteResponse.status}`));
        }
        
        // 3. Remove from database
        db.run('DELETE FROM videos WHERE id = ?', [videoId], (err) => {
          if (err) reject(err);
          else resolve({ success: true, videoId, bunnyGuid: video.bunny_guid });
        });
      });
    } catch (error) {
      reject(error);
    }
  });
}

// ========== API ENDPOINTS ==========

/**
 * POST /api/upload/video
 * Backend-mediated upload to Bunny Stream
 */
app.post('/api/upload/video', upload.single('video'), async (req, res) => {
  try {
    console.log('📥 Upload request received');
    
    if (!req.file) {
      return res.status(400).json({ error: 'No video file provided' });
    }
    
    const { title, description, collectionId } = req.body;
    const filePath = req.file.path;
    
    console.log(`📁 Processing: ${req.file.originalname} (${Math.round(req.file.size / (1024 * 1024))}MB)`);
    
    // 1. Upload to Bunny Stream
    const bunnyResult = await uploadToBunnyStream(filePath, {
      title: title || req.file.originalname,
      collectionId
    });
    
    // 2. Store metadata in database
    const dbResult = await storeVideoMetadata({
      ...bunnyResult,
      title: title || req.file.originalname,
      description,
      fileName: req.file.originalname,
      fileSize: req.file.size,
      mimeType: req.file.mimetype
    });
    
    // 3. Clean up temporary file
    await fs.unlink(filePath).catch(() => {});
    
    // 4. Return success response
    res.json({
      success: true,
      message: 'Video uploaded and processed successfully',
      video: {
        id: dbResult.videoId,
        bunnyGuid: bunnyResult.guid,
        title: bunnyResult.title,
        duration: bunnyResult.duration,
        resolution: bunnyResult.resolution,
        thumbnail: bunnyResult.thumbnail,
        playbackUrls: bunnyResult.playbackUrls,
        uploadDate: new Date().toISOString()
      }
    });
    
    console.log(`✅ Upload complete: ${bunnyResult.guid}`);
    
  } catch (error) {
    console.error('Upload error:', error);
    
    // Clean up temporary file on error
    if (req.file && req.file.path) {
      await fs.unlink(req.file.path).catch(() => {});
    }
    
    res.status(500).json({
      error: 'Upload failed',
      message: error.message,
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

/**
 * DELETE /api/video/:id
 * Delete video from Bunny and database
 */
app.delete('/api/video/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const result = await deleteVideoFromSystem(id);
    
    res.json({
      success: true,
      message: 'Video deleted successfully',
      deleted: result
    });
    
  } catch (error) {
    console.error('Delete error:', error);
    res.status(500).json({
      error: 'Delete failed',
      message: error.message
    });
  }
});

/**
 * GET /api/videos
 * List all videos with metadata
 */
app.get('/api/videos', (req, res) => {
  db.all('SELECT id, bunny_guid, title, description, filename, file_size, duration, resolution, upload_date, views, status FROM videos ORDER BY upload_date DESC', (err, rows) => {
    if (err) {
      res.status(500).json({ error: 'Database error', message: err.message });
    } else {
      res.json({ videos: rows });
    }
  });
});

/**
 * GET /api/video/:id
 * Get video details including Bunny playback URLs
 */
app.get('/api/video/:id', (req, res) => {
  const { id } = req.params;
  
  db.get('SELECT * FROM videos WHERE id = ?', [id], (err, video) => {
    if (err) {
      return res.status(500).json({ error: 'Database error', message: err.message });
    }
    
    if (!video) {
      return res.status(404).json({ error: 'Video not found' });
    }
    
    // Parse metadata JSON
    const metadata = video.metadata ? JSON.parse(video.metadata) : {};
    
    res.json({
      ...video,
      metadata,
      playbackUrls: metadata.playbackUrls || {
        hls: `https://${BUNNY_CONFIG.hostname}/${video.bunny_guid}/playlist.m3u8`,
        iframe: `https://iframe.mediadelivery.net/embed/${BUNNY_CONFIG.libraryId}/${video.bunny_guid}`
      }
    });
  });
});

// ========== VIDEO CLEANUP SYSTEM ==========

/**
 * Scheduled cleanup job for old videos
 */
async function runVideoCleanup() {
  console.log('🧹 Starting video cleanup job...');
  
  const retentionDays = parseInt(process.env.VIDEO_RETENTION_DAYS || 30);
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
  
  try {
    // Find videos older than retention period
    db.all(
      'SELECT id, bunny_guid, filename, upload_date FROM videos WHERE upload_date < ? AND status = ?',
      [cutoffDate.toISOString(), 'active'],
      async (err, oldVideos) => {
        if (err) {
          console.error('Cleanup query error:', err);
          logCleanupResult(0, 0, err.message);
          return;
        }
        
        if (oldVideos.length === 0) {
          console.log('✅ No videos to clean up');
          logCleanupResult(0, 0);
          return;
        }
        
        console.log(`🗑️ Found ${oldVideos.length} videos older than ${retentionDays} days`);
        
        let deletedCount = 0;
        let totalSizeDeleted = 0;
        
        // Delete each old video
        for (const video of oldVideos) {
          try {
            await deleteVideoFromSystem(video.id);
            deletedCount++;
            totalSizeDeleted += video.file_size || 0;
            console.log(`✅ Deleted: ${video.filename} (${video.bunny_guid})`);
          } catch (error) {
            console.error(`❌ Failed to delete ${video.bunny_guid}:`, error.message);
          }
        }
        
        // Log cleanup result
        logCleanupResult(deletedCount, totalSizeDeleted);
        console.log(`🧹 Cleanup complete: ${deletedCount} videos deleted`);
      }
    );
    
  } catch (error) {
    console.error('Cleanup job error:', error);
    logCleanupResult(0, 0, error.message);
  }
}

function logCleanupResult(deletedCount, totalSize, error = null) {
  db.run(
    'INSERT INTO cleanup_logs (videos_deleted, total_size_deleted, error) VALUES (?, ?, ?)',
    [deletedCount, totalSize, error],
    (err) => {
      if (err) console.error('Failed to log cleanup:', err);
    }
  );
}

// Schedule cleanup to run daily at 2 AM
const cleanupJob = new CronJob(
  '0 2 * * *', // Every day at 2:00 AM
  runVideoCleanup,
  null,
  true,
  'UTC'
);

console.log(`⏰ Cleanup job scheduled: Daily at 2:00 AM UTC`);

// ========== HEALTH CHECK ==========
app.get('/health', (req, res) => {
  const health = {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    bunny: {
      libraryId: BUNNY_CONFIG.libraryId,
      hostname: BUNNY_CONFIG.hostname,
      configured: !!BUNNY_CONFIG.apiKey
    },
    database: 'connected',
    cleanup: {
      scheduled: cleanupJob.running,
      nextRun: cleanupJob.nextDate().toISO()
    }
  };
  
  res.json(health);
});

// ========== ERROR HANDLING ==========
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        error: 'File too large',
        message: `Maximum file size is ${process.env.MAX_FILE_SIZE_MB || 5120}MB`
      });
    }
  }
  
  res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
  });
});

// ========== START SERVER ==========
app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════╗
║        KINAFLIX TV - Video Management           ║
║         Server running on port ${PORT}          ║
║         Environment: ${process.env.NODE_ENV}            ║
╚═══════════════════════════════════════════════════╝

📁 Endpoints:
  POST   /api/upload/video    - Upload video to Bunny Stream
  DELETE /api/video/:id       - Delete video
  GET    /api/videos          - List all videos
  GET    /api/video/:id       - Get video details
  GET    /health             - Health check

🔐 Security:
  Bunny API Key: ${BUNNY_CONFIG.apiKey ? '✓ Configured' : '✗ Missing'}
  Library ID: ${BUNNY_CONFIG.libraryId}
  CDN Hostname: ${BUNNY_CONFIG.hostname}

🧹 Cleanup:
  Retention: ${process.env.VIDEO_RETENTION_DAYS || 30} days
  Scheduled: Daily at 2:00 AM UTC
  Max file size: ${process.env.MAX_FILE_SIZE_MB || 5120}MB

🚀 Ready for production deployment on Railway/Fly.io/Koyeb
  `);
});

// Export for programmatic cleanup
module.exports = { app, runVideoCleanup };
