/**
 * KINAFLIX TV - Streaming Server
 * Backend: Node.js + Express + Socket.IO
 * Features: Video streaming, real-time sync, chat, admin controls
 * Fixed for Render deployment - removed rawSocket.setNoDelay() crash
 */

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const fs = require('fs').promises;
const multer = require('multer');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  transports: ['websocket', 'polling'],
  pingTimeout: 60000,
  pingInterval: 25000,
  connectionStateRecovery: {
    maxDisconnectionDuration: 120000,
    skipMiddlewares: true
  }
});

// Configuration
const PORT = process.env.PORT || 3000;
const MAX_VIEWERS = 80;
const VIDEOS_DIR = path.join(__dirname, 'videos');
const SUBTITLES_DIR = path.join(__dirname, 'subtitles');

// Ensure directories exist
(async () => {
  await fs.mkdir(VIDEOS_DIR, { recursive: true });
  await fs.mkdir(SUBTITLES_DIR, { recursive: true });
})();

// Store for real-time data
const connectedUsers = new Map(); // socket.id -> {name, type, room, joinTime}
let roomState = {
  currentVideo: null,
  isPlaying: false,
  currentTime: 0,
  playlist: [],
  chatHistory: [],
  subtitleEnabled: false,
  subtitleFile: null,
  streamStartTime: null,
  serverUptime: Date.now()
};

// Storage setup for file uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    if (file.mimetype === 'text/vtt') {
      cb(null, SUBTITLES_DIR);
    } else {
      cb(null, VIDEOS_DIR);
    }
  },
  filename: function (req, file, cb) {
    const safeName = file.originalname.replace(/[^a-zA-Z0-9.]/g, '_');
    cb(null, Date.now() + '-' + safeName);
  }
});

const upload = multer({ 
  storage: storage,
  limits: { fileSize: 500 * 1024 * 1024 } // 500MB limit
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname, {
  setHeaders: (res, path) => {
    if (path.endsWith('.css')) {
      res.setHeader('Content-Type', 'text/css');
    }
    if (path.endsWith('.js')) {
      res.setHeader('Content-Type', 'application/javascript');
    }
    if (path.endsWith('.html')) {
      res.setHeader('Content-Type', 'text/html');
    }
  }
}));
app.use('/videos', express.static(VIDEOS_DIR, {
  maxAge: '1h',
  setHeaders: (res, path) => {
    res.setHeader('Cache-Control', 'public, max-age=3600');
  }
}));
app.use('/subtitles', express.static(SUBTITLES_DIR));

// Favicon fix
app.get('/favicon.ico', (req, res) => {
  res.status(204).end();
});

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'view.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

// Health check endpoint for Render
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    viewers: Array.from(connectedUsers.values()).filter(u => u.type === 'viewer').length,
    streamActive: roomState.currentVideo !== null
  });
});

// Get current state
app.get('/api/state', (req, res) => {
  res.json({
    ...roomState,
    serverUptime: Date.now() - roomState.serverUptime,
    connectedViewers: Array.from(connectedUsers.values()).filter(u => u.type === 'viewer').length
  });
});

// Get connected users with watch time
app.get('/api/users', (req, res) => {
  const users = Array.from(connectedUsers.values()).map(user => ({
    ...user,
    watchTime: user.joinTime ? Date.now() - user.joinTime : 0
  }));
  res.json(users);
});

// Upload video
app.post('/api/upload/video', upload.single('video'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    
    const videoInfo = {
      id: Date.now().toString(),
      filename: req.file.filename,
      originalName: req.file.originalname,
      path: `/videos/${req.file.filename}`,
      size: req.file.size,
      uploadedAt: new Date().toISOString(),
      mimeType: req.file.mimetype
    };
    
    roomState.playlist.push(videoInfo);
    
    // If this is the first video, set it as current
    if (!roomState.currentVideo && roomState.playlist.length > 0) {
      roomState.currentVideo = roomState.playlist[0];
      if (!roomState.streamStartTime) {
        roomState.streamStartTime = new Date().toISOString();
      }
    }
    
    io.emit('playlistUpdate', roomState.playlist);
    res.json(videoInfo);
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: 'Upload failed', details: error.message });
  }
});

// Upload subtitle
app.post('/api/upload/subtitle', upload.single('subtitle'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No subtitle file' });
    
    roomState.subtitleFile = `/subtitles/${req.file.filename}`;
    io.emit('subtitleUpdate', roomState.subtitleFile);
    res.json({ subtitle: roomState.subtitleFile });
  } catch (error) {
    console.error('Subtitle upload error:', error);
    res.status(500).json({ error: 'Upload failed', details: error.message });
  }
});

// Remove video from playlist
app.delete('/api/video/:id', (req, res) => {
  try {
    const videoId = req.params.id;
    roomState.playlist = roomState.playlist.filter(v => v.id !== videoId);
    
    // If current video was removed, set new current
    if (roomState.currentVideo && roomState.currentVideo.id === videoId) {
      roomState.currentVideo = roomState.playlist.length > 0 ? roomState.playlist[0] : null;
      roomState.currentTime = 0;
      roomState.isPlaying = false;
      io.emit('videoChange', roomState.currentVideo);
      io.emit('playbackState', { 
        isPlaying: roomState.isPlaying, 
        currentTime: roomState.currentTime 
      });
    }
    
    io.emit('playlistUpdate', roomState.playlist);
    res.json({ success: true });
  } catch (error) {
    console.error('Delete error:', error);
    res.status(500).json({ error: 'Delete failed', details: error.message });
  }
});

// Reorder playlist
app.post('/api/playlist/reorder', (req, res) => {
  try {
    const newOrder = req.body.playlist;
    roomState.playlist = newOrder;
    io.emit('playlistUpdate', roomState.playlist);
    res.json({ success: true });
  } catch (error) {
    console.error('Reorder error:', error);
    res.status(500).json({ error: 'Reorder failed', details: error.message });
  }
});

// Clear entire playlist
app.delete('/api/playlist/clear', (req, res) => {
  try {
    roomState.playlist = [];
    if (roomState.currentVideo) {
      roomState.currentVideo = null;
      roomState.currentTime = 0;
      roomState.isPlaying = false;
      io.emit('videoChange', null);
      io.emit('playbackState', { isPlaying: false, currentTime: 0 });
    }
    io.emit('playlistUpdate', []);
    res.json({ success: true });
  } catch (error) {
    console.error('Clear playlist error:', error);
    res.status(500).json({ error: 'Clear failed', details: error.message });
  }
});

// Socket.IO connection handling with error resilience
io.on('connection', (socket) => {
  console.log('New connection:', socket.id);
  
  // Send immediate ping for latency measurement
  socket.emit('ping', { timestamp: Date.now() });
  
  // Check if viewer limit reached
  const viewerCount = Array.from(connectedUsers.values())
    .filter(user => user.type === 'viewer').length;
  
  // User type detection (admin/viewer)
  socket.on('identify', (data) => {
    try {
      const { name, type } = data;
      
      // Admin can always connect
      if (type === 'admin') {
        connectedUsers.set(socket.id, { 
          id: socket.id,
          name: name || 'Admin', 
          type: 'admin',
          joinTime: Date.now(),
          ip: socket.handshake.address
        });
        socket.emit('identified', { isAdmin: true, socketId: socket.id });
        socket.emit('roomState', roomState);
        io.emit('adminOnline', true);
        return;
      }
      
      // Check viewer limit
      if (viewerCount >= MAX_VIEWERS) {
        socket.emit('viewerLimitReached', MAX_VIEWERS);
        socket.disconnect();
        return;
      }
      
      // Viewer connection
      connectedUsers.set(socket.id, { 
        id: socket.id,
        name: name || `Viewer_${socket.id.substring(0, 5)}`, 
        type: 'viewer',
        joinTime: Date.now(),
        ip: socket.handshake.address
      });
      
      socket.emit('identified', { isAdmin: false, socketId: socket.id });
      socket.emit('roomState', roomState);
      
      // Notify everyone about new viewer
      const viewerList = Array.from(connectedUsers.values())
        .filter(user => user.type === 'viewer');
      
      io.emit('userJoin', { 
        id: socket.id, 
        name: connectedUsers.get(socket.id).name,
        viewerCount: viewerList.length
      });
      
      // Send updated user list to admin
      io.emit('userListUpdate', viewerList);
    } catch (error) {
      console.error('Identify error:', error);
      socket.emit('error', { message: 'Identification failed' });
    }
  });
  
  // Handle ping responses for latency measurement
  socket.on('pong', (data) => {
    const latency = Date.now() - data.timestamp;
    socket.latency = latency;
    socket.emit('latency', { latency });
  });
  
  // Admin playback controls with validation
  socket.on('playVideo', () => {
    try {
      const user = connectedUsers.get(socket.id);
      if (user && user.type === 'admin') {
        roomState.isPlaying = true;
        roomState.currentTime = roomState.currentTime || 0;
        io.emit('playVideo', { 
          currentTime: roomState.currentTime,
          timestamp: Date.now() 
        });
      }
    } catch (error) {
      console.error('Play error:', error);
    }
  });
  
  socket.on('pauseVideo', () => {
    try {
      const user = connectedUsers.get(socket.id);
      if (user && user.type === 'admin') {
        roomState.isPlaying = false;
        io.emit('pauseVideo', { timestamp: Date.now() });
      }
    } catch (error) {
      console.error('Pause error:', error);
    }
  });
  
  socket.on('seekVideo', (time) => {
    try {
      const user = connectedUsers.get(socket.id);
      if (user && user.type === 'admin') {
        if (typeof time !== 'number' || time < 0) {
          socket.emit('error', { message: 'Invalid seek time' });
          return;
        }
        roomState.currentTime = time;
        io.emit('seekVideo', { time, timestamp: Date.now() });
      }
    } catch (error) {
      console.error('Seek error:', error);
    }
  });
  
  socket.on('nextVideo', () => {
    try {
      const user = connectedUsers.get(socket.id);
      if (user && user.type === 'admin' && roomState.playlist.length > 0) {
        const currentIndex = roomState.playlist.findIndex(
          v => v.id === roomState.currentVideo?.id
        );
        const nextIndex = (currentIndex + 1) % roomState.playlist.length;
        roomState.currentVideo = roomState.playlist[nextIndex];
        roomState.currentTime = 0;
        roomState.isPlaying = true;
        io.emit('videoChange', roomState.currentVideo);
        io.emit('playVideo', { currentTime: 0, timestamp: Date.now() });
      }
    } catch (error) {
      console.error('Next video error:', error);
    }
  });
  
  socket.on('previousVideo', () => {
    try {
      const user = connectedUsers.get(socket.id);
      if (user && user.type === 'admin' && roomState.playlist.length > 0) {
        const currentIndex = roomState.playlist.findIndex(
          v => v.id === roomState.currentVideo?.id
        );
        const prevIndex = currentIndex > 0 ? currentIndex - 1 : roomState.playlist.length - 1;
        roomState.currentVideo = roomState.playlist[prevIndex];
        roomState.currentTime = 0;
        roomState.isPlaying = true;
        io.emit('videoChange', roomState.currentVideo);
        io.emit('playVideo', { currentTime: 0, timestamp: Date.now() });
      }
    } catch (error) {
      console.error('Previous video error:', error);
    }
  });
  
  socket.on('selectVideo', (videoId) => {
    try {
      const user = connectedUsers.get(socket.id);
      if (user && user.type === 'admin') {
        const video = roomState.playlist.find(v => v.id === videoId);
        if (video) {
          roomState.currentVideo = video;
          roomState.currentTime = 0;
          roomState.isPlaying = true;
          io.emit('videoChange', roomState.currentVideo);
          io.emit('playVideo', { currentTime: 0, timestamp: Date.now() });
        }
      }
    } catch (error) {
      console.error('Select video error:', error);
    }
  });
  
  socket.on('toggleSubtitles', (enabled) => {
    try {
      const user = connectedUsers.get(socket.id);
      if (user && user.type === 'admin') {
        roomState.subtitleEnabled = enabled;
        io.emit('subtitlesToggle', { enabled, timestamp: Date.now() });
      }
    } catch (error) {
      console.error('Toggle subtitles error:', error);
    }
  });
  
  // Chat messages with rate limiting
  const chatRateLimit = new Map();
  socket.on('chatMessage', (data) => {
    try {
      const user = connectedUsers.get(socket.id);
      if (!user || !data.message || !data.message.trim()) {
        return;
      }
      
      // Rate limiting: max 5 messages per 10 seconds
      const now = Date.now();
      const userMessages = chatRateLimit.get(socket.id) || [];
      const recentMessages = userMessages.filter(time => now - time < 10000);
      
      if (recentMessages.length >= 5) {
        socket.emit('error', { message: 'Message rate limit exceeded' });
        return;
      }
      
      recentMessages.push(now);
      chatRateLimit.set(socket.id, recentMessages);
      
      const messageText = data.message.trim().substring(0, 500); // Limit message length
      const message = {
        id: Date.now().toString(),
        userId: socket.id,
        userName: user.name,
        text: messageText,
        timestamp: new Date().toISOString(),
        isAdmin: user.type === 'admin'
      };
      
      roomState.chatHistory.push(message);
      
      // Keep only last 100 messages
      if (roomState.chatHistory.length > 100) {
        roomState.chatHistory = roomState.chatHistory.slice(-100);
      }
      
      io.emit('chatMessage', message);
    } catch (error) {
      console.error('Chat message error:', error);
    }
  });
  
  // Sync request from viewer
  socket.on('syncRequest', () => {
    try {
      const user = connectedUsers.get(socket.id);
      if (user && user.type === 'viewer') {
        socket.emit('syncResponse', {
          currentVideo: roomState.currentVideo,
          isPlaying: roomState.isPlaying,
          currentTime: roomState.currentTime,
          subtitleEnabled: roomState.subtitleEnabled,
          subtitleFile: roomState.subtitleFile,
          timestamp: Date.now()
        });
      }
    } catch (error) {
      console.error('Sync error:', error);
    }
  });
  
  // Admin kick user
  socket.on('kickUser', (userId) => {
    try {
      const admin = connectedUsers.get(socket.id);
      if (admin && admin.type === 'admin') {
        const userSocket = io.sockets.sockets.get(userId);
        if (userSocket) {
          userSocket.emit('kicked', { reason: 'Removed by admin', timestamp: Date.now() });
          setTimeout(() => {
            if (userSocket.connected) {
              userSocket.disconnect();
            }
          }, 1000);
        }
      }
    } catch (error) {
      console.error('Kick user error:', error);
    }
  });
  
  // Request user list (admin)
  socket.on('requestUserList', () => {
    try {
      const user = connectedUsers.get(socket.id);
      if (user && user.type === 'admin') {
        const viewerList = Array.from(connectedUsers.values())
          .filter(u => u.type === 'viewer')
          .map(u => ({
            ...u,
            watchTime: u.joinTime ? Date.now() - u.joinTime : 0,
            latency: io.sockets.sockets.get(u.id)?.latency || 0
          }));
        socket.emit('userListUpdate', viewerList);
      }
    } catch (error) {
      console.error('User list error:', error);
    }
  });
  
  // Request server stats
  socket.on('requestStats', () => {
    try {
      socket.emit('serverStats', {
        uptime: Date.now() - roomState.serverUptime,
        memoryUsage: process.memoryUsage(),
        connectedUsers: connectedUsers.size,
        viewerCount: Array.from(connectedUsers.values()).filter(u => u.type === 'viewer').length,
        playlistLength: roomState.playlist.length,
        chatHistoryLength: roomState.chatHistory.length
      });
    } catch (error) {
      console.error('Stats error:', error);
    }
  });
  
  // Disconnection
  socket.on('disconnect', (reason) => {
    try {
      const user = connectedUsers.get(socket.id);
      if (user) {
        connectedUsers.delete(socket.id);
        chatRateLimit.delete(socket.id);
        
        if (user.type === 'viewer') {
          const viewerList = Array.from(connectedUsers.values())
            .filter(u => u.type === 'viewer');
          
          io.emit('userLeave', { 
            id: socket.id, 
            name: user.name,
            viewerCount: viewerList.length,
            reason: reason
          });
          
          // Update user list for admin
          io.emit('userListUpdate', viewerList.map(u => ({
            ...u,
            watchTime: u.joinTime ? Date.now() - u.joinTime : 0
          })));
        } else if (user.type === 'admin') {
          io.emit('adminOnline', false);
        }
        
        console.log('User disconnected:', socket.id, user.name, 'Reason:', reason);
      }
    } catch (error) {
      console.error('Disconnect error:', error);
    }
  });
  
  // Error handling
  socket.on('error', (error) => {
    console.error('Socket error:', socket.id, error);
  });
});

// Graceful shutdown handling
process.on('SIGTERM', () => {
  console.log('SIGTERM received. Shutting down gracefully...');
  io.emit('serverShutdown', { message: 'Server is restarting', timestamp: Date.now() });
  
  setTimeout(() => {
    server.close(() => {
      console.log('Server closed');
      process.exit(0);
    });
  }, 5000);
});

process.on('SIGINT', () => {
  console.log('SIGINT received. Shutting down...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

// Start server - REMOVED the problematic rawSocket.setNoDelay() code
server.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔═══════════════════════════════════════════════════╗
║        KINAFLIX TV Streaming Server              ║
║         Ready on http://localhost:${PORT}          ║
║      Admin: http://localhost:${PORT}/admin        ║
║      Viewer: http://localhost:${PORT}             ║
║    Max Viewers: ${MAX_VIEWERS}                      ║
║           Optimized for Render.com               ║
╚═══════════════════════════════════════════════════╝
  
📡 Server Information:
• Port: ${PORT}
• Environment: ${process.env.NODE_ENV || 'development'}
• Node.js: ${process.version}
• Platform: ${process.platform}
• Uptime tracking: Enabled
• Health endpoint: /health
• API endpoint: /api/state

🚀 Ready for connections...
  `);
});

// Periodic cleanup
setInterval(() => {
  // Clean up rate limit cache
  const now = Date.now();
  for (const [socketId, messages] of chatRateLimit.entries()) {
    const recentMessages = messages.filter(time => now - time < 60000); // Keep 1 minute
    if (recentMessages.length === 0) {
      chatRateLimit.delete(socketId);
    } else {
      chatRateLimit.set(socketId, recentMessages);
    }
  }
}, 60000); // Run every minute
