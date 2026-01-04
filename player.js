class VideoPlayer {
    constructor() {
        this.videoElement = document.getElementById('videoPlayer');
        this.nextVideoElement = null;
        this.preloadedVideos = new Map();
        this.errorCount = 0;
        this.maxErrors = 2;
        this.isPlaying = false;
        this.currentVideo = null;
        
        this.init();
    }
    
    init() {
        this.setupVideoElement();
        this.setupEventListeners();
        this.startPreloading();
        
        // Listen for video changes
        window.addEventListener('kinaflix:videoChanged', (e) => {
            this.playVideo(e.detail);
        });
        
        // Start with first video
        setTimeout(() => {
            if (window.kinaflix.currentVideo) {
                this.playVideo(window.kinaflix.currentVideo);
            }
        }, 1000);
    }
    
    setupVideoElement() {
        // Optimize for low latency
        this.videoElement.preload = 'auto';
        this.videoElement.playsInline = true;
        this.videoElement.crossOrigin = 'anonymous';
        this.videoElement.muted = true; // Start muted for autoplay
        
        // Create hidden video for preloading
        this.nextVideoElement = document.createElement('video');
        this.nextVideoElement.preload = 'auto';
        this.nextVideoElement.style.display = 'none';
        document.body.appendChild(this.nextVideoElement);
    }
    
    setupEventListeners() {
        // Error handling
        this.videoElement.addEventListener('error', (e) => {
            console.error('Video error:', e);
            this.errorCount++;
            
            if (this.errorCount >= this.maxErrors) {
                console.log('Skipping to next video due to errors');
                this.skipToNext();
            } else {
                // Retry with cache busting
                setTimeout(() => {
                    this.videoElement.src = this.currentVideo.url + '?t=' + Date.now();
                    this.videoElement.load();
                    this.videoElement.play().catch(console.error);
                }, 1000);
            }
        });
        
        // End of video
        this.videoElement.addEventListener('ended', () => {
            console.log('Video ended, playing next');
            this.skipToNext();
        });
        
        // Can play through
        this.videoElement.addEventListener('canplaythrough', () => {
            console.log('Video loaded successfully');
            this.errorCount = 0;
            
            // Update UI
            if (this.currentVideo) {
                document.getElementById('currentVideoTitle').textContent = this.currentVideo.name;
            }
        });
        
        // Time update for preloading
        this.videoElement.addEventListener('timeupdate', () => {
            if (this.videoElement.duration > 0) {
                const remainingTime = this.videoElement.duration - this.videoElement.currentTime;
                
                // Preload next video when current is 75% complete
                if (remainingTime < this.videoElement.duration * 0.25) {
                    this.preloadNextVideo();
                }
                
                // Update progress bar
                const progress = (this.videoElement.currentTime / this.videoElement.duration) * 100;
                document.getElementById('progressBar').style.width = `${progress}%`;
            }
        });
        
        // Controls
        document.getElementById('playPauseBtn').addEventListener('click', () => {
            this.togglePlayPause();
        });
        
        document.getElementById('muteBtn').addEventListener('click', () => {
            this.toggleMute();
        });
        
        document.getElementById('nextBtn').addEventListener('click', () => {
            this.skipToNext();
        });
        
        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => {
            switch(e.key) {
                case ' ':
                case 'k':
                    e.preventDefault();
                    this.togglePlayPause();
                    break;
                case 'n':
                case 'ArrowRight':
                    e.preventDefault();
                    this.skipToNext();
                    break;
                case 'p':
                case 'ArrowLeft':
                    e.preventDefault();
                    this.playPrevious();
                    break;
                case 'm':
                    e.preventDefault();
                    this.toggleMute();
                    break;
            }
        });
    }
    
    async playVideo(video) {
        if (!video || !video.url) return;
        
        console.log('Playing video:', video.name);
        this.currentVideo = video;
        
        // If video is already preloaded, use preloaded version
        if (this.preloadedVideos.has(video.id)) {
            const preloaded = this.preloadedVideos.get(video.id);
            this.videoElement.src = preloaded.src;
        } else {
            // Load fresh with cache busting
            this.videoElement.src = video.url + '?t=' + Date.now();
        }
        
        // Update title immediately
        document.getElementById('currentVideoTitle').textContent = video.name;
        
        try {
            await this.videoElement.play();
            this.isPlaying = true;
            this.updatePlayButton();
            
            // Start preloading next videos
            this.startPreloading();
            
        } catch (error) {
            console.error('Play error:', error);
            
            // If autoplay fails, show play button
            this.isPlaying = false;
            this.updatePlayButton();
            
            // Add click-to-play listener
            const playOnce = () => {
                this.videoElement.play().catch(console.error);
                this.videoElement.removeEventListener('click', playOnce);
            };
            this.videoElement.addEventListener('click', playOnce);
        }
    }
    
    skipToNext() {
        const nextVideo = window.kinaflix.getNextVideo();
        if (nextVideo) {
            this.playVideo(nextVideo);
        }
    }
    
    playPrevious() {
        const prevVideo = window.kinaflix.getPreviousVideo();
        if (prevVideo) {
            this.playVideo(prevVideo);
        }
    }
    
    playCurrentVideo() {
        if (window.kinaflix.currentVideo) {
            this.playVideo(window.kinaflix.currentVideo);
        }
    }
    
    togglePlayPause() {
        if (this.videoElement.paused) {
            this.videoElement.play();
            this.isPlaying = true;
        } else {
            this.videoElement.pause();
            this.isPlaying = false;
        }
        this.updatePlayButton();
    }
    
    toggleMute() {
        this.videoElement.muted = !this.videoElement.muted;
        const icon = document.querySelector('#muteBtn i');
        icon.className = this.videoElement.muted ? 'fas fa-volume-mute' : 'fas fa-volume-up';
    }
    
    updatePlayButton() {
        const icon = document.querySelector('#playPauseBtn i');
        icon.className = this.isPlaying ? 'fas fa-pause' : 'fas fa-play';
    }
    
    startPreloading() {
        // Preload next 2 videos
        const videos = window.kinaflix.videos;
        if (videos.length < 2) return;
        
        for (let i = 1; i <= 2; i++) {
            const nextIndex = (window.kinaflix.currentIndex + i) % videos.length;
            const nextVideo = videos[nextIndex];
            
            if (nextVideo && !this.preloadedVideos.has(nextVideo.id)) {
                this.preloadVideo(nextVideo);
            }
        }
    }
    
    preloadNextVideo() {
        const videos = window.kinaflix.videos;
        if (videos.length < 2) return;
        
        const nextIndex = (window.kinaflix.currentIndex + 1) % videos.length;
        const nextVideo = videos[nextIndex];
        
        if (nextVideo && !this.preloadedVideos.has(nextVideo.id)) {
            this.preloadVideo(nextVideo);
        }
    }
    
    preloadVideo(video) {
        const preloadVideo = document.createElement('video');
        preloadVideo.preload = 'auto';
        preloadVideo.style.display = 'none';
        preloadVideo.src = video.url + '?preload=' + Date.now();
        
        preloadVideo.onloadeddata = () => {
            this.preloadedVideos.set(video.id, preloadVideo);
            console.log('Preloaded video:', video.name);
        };
        
        preloadVideo.onerror = () => {
            console.log('Failed to preload video:', video.name);
        };
        
        document.body.appendChild(preloadVideo);
        
        // Clean up old preloaded videos
        if (this.preloadedVideos.size > 3) {
            const firstKey = this.preloadedVideos.keys().next().value;
            const oldVideo = this.preloadedVideos.get(firstKey);
            if (oldVideo && oldVideo.parentNode) {
                oldVideo.parentNode.removeChild(oldVideo);
            }
            this.preloadedVideos.delete(firstKey);
        }
    }
}

// Initialize player
document.addEventListener('DOMContentLoaded', () => {
    window.player = new VideoPlayer();
});
