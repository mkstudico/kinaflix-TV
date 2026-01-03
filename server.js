/**
 * KINAFLIX TV - Streaming Server
 * Simple, stable version for Render
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
  cors: { origin: "*" },
  transports: ['websocket', 'polling']
});

// Configuration
const PORT = process.env.PORT || 3000;
const MAX_VIEWERS = 80;

// Store for real-time data
let connectedUsers = new Map();
let roomState = {
  currentVideo: null,
  isPlaying: false,
  currentTime: 0,
  playlist: [],
  chatHistory: [],
  subtitleEnabled: false,
  subtitleFile: null
};

// Middleware
app.use(cors());
app.use(express.json());

// Serve all files from root directory
app.use(express.static(__dirname));

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'view.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok',
    time: new Date().toISOString(),
    viewers: Array.from(connectedUsers.values()).filter(u => u.type === 'viewer').length
  });
});

// Socket.IO
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  
  socket.on('identify', (data) => {
    const { name, type } = data;
    
    if (type === 'admin') {
      connectedUsers.set(socket.id, { 
        name: name || 'Admin', 
        type: 'admin' 
      });
      socket.emit('identified', { isAdmin: true });
      socket.emit('roomState', roomState);
      return;
    }
    
    // Check viewer limit
    const viewerCount = Array.from(connectedUsers.values())
      .filter(u => u.type === 'viewer').length;
    
    if (viewerCount >= MAX_VIEWERS) {
      socket.emit('viewerLimitReached', MAX_VIEWERS);
      socket.disconnect();
      return;
    }
    
    connectedUsers.set(socket.id, { 
      name: name || `Viewer_${socket.id.substring(0, 5)}`, 
      type: 'viewer' 
    });
    
    socket.emit('identified', { isAdmin: false });
    socket.emit('roomState', roomState);
    io.emit('userJoin', { 
      id: socket.id, 
      name: connectedUsers.get(socket.id).name,
      viewerCount: viewerCount + 1 
    });
  });
  
  // Admin controls
  socket.on('playVideo', () => {
    const user = connectedUsers.get(socket.id);
    if (user?.type === 'admin') {
      roomState.isPlaying = true;
      io.emit('playVideo');
    }
  });
  
  socket.on('pauseVideo', () => {
    const user = connectedUsers.get(socket.id);
    if (user?.type === 'admin') {
      roomState.isPlaying = false;
      io.emit('pauseVideo');
    }
  });
  
  socket.on('seekVideo', (time) => {
    const user = connectedUsers.get(socket.id);
    if (user?.type === 'admin') {
      roomState.currentTime = time;
      io.emit('seekVideo', time);
    }
  });
  
  socket.on('nextVideo', () => {
    const user = connectedUsers.get(socket.id);
    if (user?.type === 'admin' && roomState.playlist.length > 0) {
      const currentIndex = roomState.playlist.findIndex(
        v => v.id === roomState.currentVideo?.id
      );
      const nextIndex = (currentIndex + 1) % roomState.playlist.length;
      roomState.currentVideo = roomState.playlist[nextIndex];
      roomState.currentTime = 0;
      roomState.isPlaying = true;
      io.emit('videoChange', roomState.currentVideo);
      io.emit('playVideo');
    }
  });
  
  socket.on('previousVideo', () => {
    const user = connectedUsers.get(socket.id);
    if (user?.type === 'admin' && roomState.playlist.length > 0) {
      const currentIndex = roomState.playlist.findIndex(
        v => v.id === roomState.currentVideo?.id
      );
      const prevIndex = currentIndex > 0 ? currentIndex - 1 : roomState.playlist.length - 1;
      roomState.currentVideo = roomState.playlist[prevIndex];
      roomState.currentTime = 0;
      roomState.isPlaying = true;
      io.emit('videoChange', roomState.currentVideo);
      io.emit('playVideo');
    }
  });
  
  socket.on('selectVideo', (videoId) => {
    const user = connectedUsers.get(socket.id);
    if (user?.type === 'admin') {
      const video = roomState.playlist.find(v => v.id === videoId);
      if (video) {
        roomState.currentVideo = video;
        roomState.currentTime = 0;
        io.emit('videoChange', roomState.currentVideo);
      }
    }
  });
  
  socket.on('toggleSubtitles', (enabled) => {
    const user = connectedUsers.get(socket.id);
    if (user?.type === 'admin') {
      roomState.subtitleEnabled = enabled;
      io.emit('subtitlesToggle', enabled);
    }
  });
  
  // Chat
  socket.on('chatMessage', (data) => {
    const user = connectedUsers.get(socket.id);
    if (user && data.message) {
      const message = {
        id: Date.now().toString(),
        userId: socket.id,
        userName: user.name,
        text: data.message.substring(0, 200),
        timestamp: new Date().toISOString(),
        isAdmin: user.type === 'admin'
      };
      
      roomState.chatHistory.push(message);
      if (roomState.chatHistory.length > 100) {
        roomState.chatHistory = roomState.chatHistory.slice(-100);
      }
      
      io.emit('chatMessage', message);
    }
  });
  
  socket.on('syncRequest', () => {
    const user = connectedUsers.get(socket.id);
    if (user?.type === 'viewer') {
      socket.emit('syncResponse', {
        currentVideo: roomState.currentVideo,
        isPlaying: roomState.isPlaying,
        currentTime: roomState.currentTime,
        subtitleEnabled: roomState.subtitleEnabled,
        subtitleFile: roomState.subtitleFile
      });
    }
  });
  
  socket.on('disconnect', () => {
    const user = connectedUsers.get(socket.id);
    if (user) {
      connectedUsers.delete(socket.id);
      if (user.type === 'viewer') {
        const viewerCount = Array.from(connectedUsers.values())
          .filter(u => u.type === 'viewer').length;
        io.emit('userLeave', { 
          id: socket.id, 
          name: user.name,
          viewerCount 
        });
      }
      console.log('Client disconnected:', socket.id, user.name);
    }
  });
});

// Start server
server.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════╗
║        KINAFLIX TV Streaming Server              ║
║         Ready on port ${PORT}                    ║
║      Admin: http://localhost:${PORT}/admin        ║
║      Viewer: http://localhost:${PORT}             ║
║    Max Viewers: ${MAX_VIEWERS}                      ║
╚═══════════════════════════════════════════════════╝
  `);
});
