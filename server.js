/**
 * KINAFLIX TV - Streaming Server
 * Backend: Node.js + Express + Socket.IO
 * Features: Video streaming, real-time sync, chat, admin controls
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
  pingInterval: 25000
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
  streamStartTime: null
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
  }
}));
app.use('/videos', express.static(VIDEOS_DIR));
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

// Get current state
app.get('/api/state', (req, res) => {
  res.json(roomState);
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
      duration: 0 // Will be updated if we can get duration
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
    res.status(500).json({ error: 'Upload failed' });
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
    res.status(500).json({ error: 'Upload failed' });
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
    res.status(500).json({ error: 'Delete failed' });
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
    res.status(500).json({ error: 'Reorder failed' });
  }
});

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log('New connection:', socket.id);
  
  // Check if viewer limit reached
  const viewerCount = Array.from(connectedUsers.values())
    .filter(user => user.type === 'viewer').length;
  
  // User type detection (admin/viewer)
  socket.on('identify', (data) => {
    const { name, type } = data;
    
    // Admin can always connect
    if (type === 'admin') {
      connectedUsers.set(socket.id, { 
        id: socket.id,
        name: name || 'Admin', 
        type: 'admin',
        joinTime: Date.now()
      });
      socket.emit('identified', { isAdmin: true });
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
      joinTime: Date.now()
    });
    
    socket.emit('identified', { isAdmin: false });
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
  });
  
  // Admin playback controls
  socket.on('playVideo', () => {
    const user = connectedUsers.get(socket.id);
    if (user && user.type === 'admin') {
      roomState.isPlaying = true;
      roomState.currentTime = roomState.currentTime || 0;
      io.emit('playVideo', { currentTime: roomState.currentTime });
    }
  });
  
  socket.on('pauseVideo', () => {
    const user = connectedUsers.get(socket.id);
    if (user && user.type === 'admin') {
      roomState.isPlaying = false;
      io.emit('pauseVideo');
    }
  });
  
  socket.on('seekVideo', (time) => {
    const user = connectedUsers.get(socket.id);
    if (user && user.type === 'admin') {
      roomState.currentTime = time;
      io.emit('seekVideo', time);
    }
  });
  
  socket.on('nextVideo', () => {
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
      io.emit('playVideo', { currentTime: 0 });
    }
  });
  
  socket.on('previousVideo', () => {
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
      io.emit('playVideo', { currentTime: 0 });
    }
  });
  
  socket.on('selectVideo', (videoId) => {
    const user = connectedUsers.get(socket.id);
    if (user && user.type === 'admin') {
      const video = roomState.playlist.find(v => v.id === videoId);
      if (video) {
        roomState.currentVideo = video;
        roomState.currentTime = 0;
        roomState.isPlaying = true;
        io.emit('videoChange', roomState.currentVideo);
        io.emit('playVideo', { currentTime: 0 });
      }
    }
  });
  
  socket.on('toggleSubtitles', (enabled) => {
    const user = connectedUsers.get(socket.id);
    if (user && user.type === 'admin') {
      roomState.subtitleEnabled = enabled;
      io.emit('subtitlesToggle', enabled);
    }
  });
  
  // Chat messages
  socket.on('chatMessage', (data) => {
    const user = connectedUsers.get(socket.id);
    if (user && data.message && data.message.trim()) {
      const messageText = data.message.trim();
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
    }
  });
  
  // Sync request from viewer
  socket.on('syncRequest', () => {
    const user = connectedUsers.get(socket.id);
    if (user && user.type === 'viewer') {
      socket.emit('syncResponse', {
        currentVideo: roomState.currentVideo,
        isPlaying: roomState.isPlaying,
        currentTime: roomState.currentTime,
        subtitleEnabled: roomState.subtitleEnabled,
        subtitleFile: roomState.subtitleFile
      });
    }
  });
  
  // Admin kick user
  socket.on('kickUser', (userId) => {
    const admin = connectedUsers.get(socket.id);
    if (admin && admin.type === 'admin') {
      const userSocket = io.sockets.sockets.get(userId);
      if (userSocket) {
        userSocket.emit('kicked', { reason: 'Removed by admin' });
        userSocket.disconnect();
      }
    }
  });
  
  // Request user list (admin)
  socket.on('requestUserList', () => {
    const user = connectedUsers.get(socket.id);
    if (user && user.type === 'admin') {
      const viewerList = Array.from(connectedUsers.values())
        .filter(u => u.type === 'viewer')
        .map(u => ({
          ...u,
          watchTime: u.joinTime ? Date.now() - u.joinTime : 0
        }));
      socket.emit('userListUpdate', viewerList);
    }
  });
  
  // Disconnection
  socket.on('disconnect', () => {
    const user = connectedUsers.get(socket.id);
    if (user) {
      connectedUsers.delete(socket.id);
      
      if (user.type === 'viewer') {
        const viewerList = Array.from(connectedUsers.values())
          .filter(u => u.type === 'viewer');
        
        io.emit('userLeave', { 
          id: socket.id, 
          name: user.name,
          viewerCount: viewerList.length
        });
        
        // Update user list for admin
        io.emit('userListUpdate', viewerList.map(u => ({
          ...u,
          watchTime: u.joinTime ? Date.now() - u.joinTime : 0
        })));
      } else if (user.type === 'admin') {
        io.emit('adminOnline', false);
      }
      
      console.log('User disconnected:', socket.id, user.name);
    }
  });
});

// Optimize for low latency
io.engine.on("connection", (rawSocket) => {
  rawSocket.setNoDelay(true);
});

// Start server
server.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔═══════════════════════════════════════════════════╗
║        KINAFLIX TV Streaming Server              ║
║         Ready on http://localhost:${PORT}          ║
║      Admin: http://localhost:${PORT}/admin        ║
║      Viewer: http://localhost:${PORT}             ║
║    Max Viewers: ${MAX_VIEWERS}                      ║
╚═══════════════════════════════════════════════════╝
  `);
});
