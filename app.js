class KinaflixTV {
    constructor() {
        this.videos = [];
        this.currentIndex = 0;
        this.currentVideo = null;
        this.userName = null;
        this.db = firebase.firestore();
        this.chatMessages = [];
        this.maxChatMessages = 100;
        
        this.init();
    }
    
    async init() {
        await this.loadVideos();
        this.setupRealtimeUpdates();
    }
    
    async loadVideos() {
        try {
            const snapshot = await this.db.collection('videos')
                .orderBy('createdAt', 'asc')
                .get();
            
            this.videos = snapshot.docs.map(doc => ({
                id: doc.id,
                ...doc.data()
            }));
            
            if (this.videos.length === 0) {
                // Add demo videos if none exist
                await this.addDemoVideos();
            }
            
            this.currentVideo = this.videos[0];
            console.log(`Loaded ${this.videos.length} videos`);
            
        } catch (error) {
            console.error('Error loading videos:', error);
            this.videos = [];
            this.currentVideo = null;
        }
    }
    
    async addDemoVideos() {
        const demoVideos = [
            {
                name: "Nature Documentary",
                url: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4",
                createdAt: new Date()
            },
            {
                name: "Wildlife Adventure",
                url: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4",
                createdAt: new Date()
            }
        ];
        
        for (const video of demoVideos) {
            await this.db.collection('videos').add(video);
        }
    }
    
    setupRealtimeUpdates() {
        // Real-time video updates
        this.db.collection('videos')
            .orderBy('createdAt', 'asc')
            .onSnapshot((snapshot) => {
                const oldVideos = [...this.videos];
                this.videos = snapshot.docs.map(doc => ({
                    id: doc.id,
                    ...doc.data()
                }));
                
                // Check if current video changed
                if (oldVideos.length > 0 && this.videos.length > 0) {
                    const oldCurrent = oldVideos[this.currentIndex];
                    const newCurrent = this.videos[this.currentIndex];
                    
                    if (oldCurrent && newCurrent && oldCurrent.id !== newCurrent.id) {
                        this.currentVideo = newCurrent;
                        this.triggerEvent('videoChanged', this.currentVideo);
                    }
                }
                
                this.triggerEvent('videosUpdated', this.videos);
            });
    }
    
    async addVideo(name, url, position = 'append') {
        try {
            const videoData = {
                name,
                url,
                createdAt: new Date()
            };
            
            if (position === 'prepend') {
                // For prepend, we need to update all existing videos' timestamps
                // In a simple implementation, we just add to end and re-sort on client
                videoData.createdAt = new Date(Date.now() - 1000); // 1 second earlier
            } else if (position === 'now') {
                videoData.createdAt = new Date(Date.now() - 2000); // 2 seconds earlier
                // Set as current video
                this.currentIndex = 0;
            }
            
            const docRef = await this.db.collection('videos').add(videoData);
            
            if (position === 'now') {
                this.currentVideo = { id: docRef.id, ...videoData };
                this.triggerEvent('videoChanged', this.currentVideo);
            }
            
            return true;
            
        } catch (error) {
            console.error('Error adding video:', error);
            this.triggerEvent('error', { message: error.message });
            return false;
        }
    }
    
    async deleteVideo(videoId) {
        try {
            await this.db.collection('videos').doc(videoId).delete();
            return true;
        } catch (error) {
            console.error('Error deleting video:', error);
            this.triggerEvent('error', { message: error.message });
            return false;
        }
    }
    
    getNextVideo() {
        if (this.videos.length === 0) return null;
        
        this.currentIndex = (this.currentIndex + 1) % this.videos.length;
        this.currentVideo = this.videos[this.currentIndex];
        
        this.triggerEvent('videoChanged', this.currentVideo);
        return this.currentVideo;
    }
    
    getPreviousVideo() {
        if (this.videos.length === 0) return null;
        
        this.currentIndex = (this.currentIndex - 1 + this.videos.length) % this.videos.length;
        this.currentVideo = this.videos[this.currentIndex];
        
        this.triggerEvent('videoChanged', this.currentVideo);
        return this.currentVideo;
    }
    
    setCurrentVideo(video) {
        const index = this.videos.findIndex(v => v.id === video.id);
        if (index !== -1) {
            this.currentIndex = index;
            this.currentVideo = video;
            this.triggerEvent('videoChanged', this.currentVideo);
        }
    }
    
    setUserName(name) {
        this.userName = name;
        localStorage.setItem('kinaflix_username', name);
    }
    
    getUserName() {
        return this.userName || localStorage.getItem('kinaflix_username') || 'Viewer';
    }
    
    triggerEvent(eventName, detail) {
        const event = new CustomEvent(`kinaflix:${eventName}`, { detail });
        window.dispatchEvent(event);
    }
    
    // Chat methods
    async sendChatMessage(message) {
        if (!message.trim() || !this.userName) return;
        
        const chatMessage = {
            user: this.userName,
            message: message.trim(),
            timestamp: Date.now(),
            type: 'user'
        };
        
        // Add to local array first for immediate display
        this.chatMessages.push(chatMessage);
        
        // Keep only last N messages
        if (this.chatMessages.length > this.maxChatMessages) {
            this.chatMessages = this.chatMessages.slice(-this.maxChatMessages);
        }
        
        // In a real app, save to Firestore
        // await this.db.collection('chat').add(chatMessage);
        
        this.triggerEvent('chatMessage', chatMessage);
    }
    
    addSystemMessage(message) {
        const systemMessage = {
            user: 'System',
            message,
            timestamp: Date.now(),
            type: 'system'
        };
        
        this.chatMessages.push(systemMessage);
        
        if (this.chatMessages.length > this.maxChatMessages) {
            this.chatMessages = this.chatMessages.slice(-this.maxChatMessages);
        }
        
        this.triggerEvent('chatMessage', systemMessage);
    }
}

// Initialize and export
window.kinaflix = new KinaflixTV();
