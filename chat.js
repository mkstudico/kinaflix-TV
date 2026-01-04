class ChatSystem {
    constructor() {
        this.messagesContainer = document.getElementById('chatMessages');
        this.chatInput = document.getElementById('chatInput');
        this.sendButton = document.getElementById('sendBtn');
        this.userName = null;
        this.isEnabled = false;
        
        this.init();
    }
    
    init() {
        this.setupEventListeners();
        this.loadUserName();
        this.setupRealtimeChat();
        
        // Listen for user name changes
        window.addEventListener('kinaflix:userNameChanged', () => {
            this.loadUserName();
        });
    }
    
    loadUserName() {
        this.userName = window.kinaflix.getUserName();
        if (this.userName) {
            this.enableChat();
        }
    }
    
    enableChat() {
        this.isEnabled = true;
        this.chatInput.disabled = false;
        this.chatInput.placeholder = `Chat as ${this.userName}...`;
        this.sendButton.disabled = false;
        
        this.addSystemMessage(`Welcome ${this.userName}! Type to chat.`);
    }
    
    setupEventListeners() {
        // Send message on button click
        this.sendButton.addEventListener('click', () => {
            this.sendMessage();
        });
        
        // Send message on Enter key
        this.chatInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                this.sendMessage();
            }
        });
        
        // Enable send button when typing
        this.chatInput.addEventListener('input', () => {
            this.sendButton.disabled = this.chatInput.value.trim().length === 0;
        });
    }
    
    setupRealtimeChat() {
        // Listen for chat messages from app
        window.addEventListener('kinaflix:chatMessage', (e) => {
            this.addMessageToChat(e.detail);
        });
        
        // In a real app, you'd listen to Firestore
        // this.db.collection('chat')
        //     .orderBy('timestamp', 'desc')
        //     .limit(50)
        //     .onSnapshot((snapshot) => {
        //         snapshot.docChanges().forEach(change => {
        //             if (change.type === 'added') {
        //                 this.addMessageToChat(change.doc.data());
        //             }
        //         });
        //     });
    }
    
    async sendMessage() {
        const message = this.chatInput.value.trim();
        if (!message || !this.isEnabled) return;
        
        // Send through kinaflix app
        await window.kinaflix.sendChatMessage(message);
        
        // Clear input
        this.chatInput.value = '';
        this.sendButton.disabled = true;
        this.chatInput.focus();
    }
    
    addMessageToChat(messageData) {
        const messageElement = this.createMessageElement(messageData);
        
        // Add to TOP of container (reverse chat)
        this.messagesContainer.insertBefore(messageElement, this.messagesContainer.firstChild);
        
        // Limit number of messages displayed
        const maxMessages = 50;
        const allMessages = this.messagesContainer.querySelectorAll('.chat-message, .system-message');
        if (allMessages.length > maxMessages) {
            for (let i = maxMessages; i < allMessages.length; i++) {
                allMessages[i].remove();
            }
        }
        
        // Auto-scroll to show new message at top
        this.messagesContainer.scrollTop = 0;
    }
    
    createMessageElement(messageData) {
        const isSystem = messageData.type === 'system';
        const isCurrentUser = messageData.user === this.userName;
        
        const messageDiv = document.createElement('div');
        messageDiv.className = isSystem ? 'system-message' : 'chat-message';
        
        if (!isSystem) {
            if (isCurrentUser) {
                messageDiv.classList.add('own-message');
            }
        }
        
        const time = new Date(messageData.timestamp).toLocaleTimeString([], { 
            hour: '2-digit', 
            minute: '2-digit' 
        });
        
        if (isSystem) {
            messageDiv.textContent = messageData.message;
        } else {
            messageDiv.innerHTML = `
                <div class="message-header">
                    <span class="message-user">${messageData.user}</span>
                    <span class="message-time">${time}</span>
                </div>
                <div class="message-content">${this.escapeHtml(messageData.message)}</div>
            `;
        }
        
        return messageDiv;
    }
    
    addSystemMessage(text) {
        const messageData = {
            user: 'System',
            message: text,
            timestamp: Date.now(),
            type: 'system'
        };
        
        this.addMessageToChat(messageData);
    }
    
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}

// Initialize chat system
document.addEventListener('DOMContentLoaded', () => {
    window.chatSystem = new ChatSystem();
});
