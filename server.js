const express = require('express');
const app = express();
const http = require('http').Server(app);
const io = require('socket.io')(http);
const fileUpload = require('express-fileupload');
const path = require('path');
const fs = require('fs');
const ADMIN_USERNAME = 'nthdat2937';

const ADMIN_CONFIG = {
    username: 'nthdat2937',
    password: 'admin123' 
};

app.use(express.static('public'));
app.use(express.json());
app.use(fileUpload({
    createParentPath: true,
    limits: { 
        fileSize: 20 * 1024 * 1024
    },
    abortOnLimit: true,
    uploadTimeout: 30000,
    useTempFiles: true,
    tempFileDir: '/tmp/',
    debug: false,
    safeFileNames: true,
    preserveExtension: true
}));

const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)){
    fs.mkdirSync(uploadDir, { recursive: true });
}

// Clean up temporary files periodically (every 24 hours)
setInterval(() => {
    const files = fs.readdirSync(uploadDir);
    const now = Date.now();
    const oneDay = 24 * 60 * 60 * 1000;

    files.forEach(file => {
        const filePath = path.join(uploadDir, file);
        const stats = fs.statSync(filePath);
        if (now - stats.mtime.getTime() > oneDay) {
            fs.unlinkSync(filePath);
        }
    });
}, 24 * 60 * 60 * 1000);

// Store online users and authenticated admin sessions
const onlineUsers = new Map();
const authenticatedAdmins = new Set();

// Routes
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/index.html');
});

app.get('/chat.html', (req, res) => {
    res.sendFile(__dirname + '/public/chat.html');
});

// Admin verification endpoint
app.post('/verify-admin', (req, res) => {
    const { username, password } = req.body;
    
    if (username === ADMIN_CONFIG.username && password === ADMIN_CONFIG.password) {
        const sessionToken = Math.random().toString(36).substring(2) + Date.now().toString(36);
        authenticatedAdmins.add(sessionToken);
        
        // Set session token to expire after 24 hours
        setTimeout(() => {
            authenticatedAdmins.delete(sessionToken);
        }, 24 * 60 * 60 * 1000);
        
        res.json({ status: 'success', sessionToken });
    } else {
        res.status(401).json({ 
            status: 'error', 
            message: 'Invalid admin credentials' 
        });
    }
});

// File upload handler
app.post('/upload', async (req, res) => {
    try {
        if (!req.files || !req.files.file) {
            return res.status(400).json({ 
                status: 'error', 
                message: 'No file uploaded' 
            });
        }

        const file = req.files.file;
        const now = new Date();
        const timestamp = now.getTime();
        
        const fileExt = path.extname(file.name);
        const safeName = `${timestamp}-${path.basename(file.name, fileExt)}${fileExt}`;
        
        const allowedTypes = [
            'image/jpeg', 'image/png', 'image/gif', 'image/webp',
            'application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'text/plain', 'application/zip', 'application/x-rar-compressed',
            'audio/mpeg', 'video/mp4'
        ];

        if (!allowedTypes.includes(file.mimetype)) {
            return res.status(400).json({
                status: 'error',
                message: 'File type not allowed'
            });
        }

        const uploadPath = path.join(uploadDir, safeName);
        await file.mv(uploadPath);

        res.json({
            status: 'success',
            path: '/uploads/' + safeName,
            filename: file.name,
            uploadTime: now.toISOString().replace('T', ' ').slice(0, 19)
        });

    } catch (err) {
        console.error('Upload error:', err);
        res.status(500).json({
            status: 'error',
            message: 'Error uploading file'
        });
    }
});

// Socket.IO event handlers
io.on('connection', (socket) => {
    let currentUser = null;
    let isAdmin = false;
    let adminSessionToken = null;

    socket.on('join chat', (data) => {
    currentUser = data.username;
    socket.username = data.username;
    
    // Enhanced admin verification
    if (currentUser === ADMIN_USERNAME && data.sessionToken && authenticatedAdmins.has(data.sessionToken)) {
        isAdmin = true;
        adminSessionToken = data.sessionToken;
        console.log(`Admin ${currentUser} authenticated successfully`);
    } else {
        isAdmin = false;
        adminSessionToken = null;
    }

    onlineUsers.set(currentUser, {
        socketId: socket.id,
        loginTime: data.loginTime,
        isAdmin
    });

    io.emit('online users', Array.from(onlineUsers));
    
    socket.broadcast.emit('user joined', {
        username: currentUser,
        time: new Date().toISOString().replace('T', ' ').slice(0, 19)
    });

    console.log(`User ${currentUser} joined the chat${isAdmin ? ' as admin' : ''}`);
});

    // Handle kick user event
    socket.on('kick user', (data) => {
        const { userToKick, adminToken } = data;

        // Verify admin session token
        if (!adminToken || !authenticatedAdmins.has(adminToken)) {
            console.log('Unauthorized kick attempt by:', currentUser);
            socket.emit('kick error', { message: 'Bạn không có quyền kick người dùng!' });
            return;
        }

        const kickedUserData = onlineUsers.get(userToKick);
        if (kickedUserData && userToKick !== ADMIN_USERNAME) { // Prevent admin from being kicked
            // Emit kick event to the specific user
            io.to(kickedUserData.socketId).emit('kicked', {
                byUser: currentUser,
                time: new Date().toISOString().replace('T', ' ').slice(0, 19)
            });

            // Broadcast kick notification to all users
            io.emit('user kicked', {
                username: userToKick,
                byUser: currentUser,
                time: new Date().toISOString().replace('T', ' ').slice(0, 19)
            });

            // Remove user from online users
            onlineUsers.delete(userToKick);

            // Force disconnect the kicked user
            const kickedSocket = io.sockets.sockets.get(kickedUserData.socketId);
            if (kickedSocket) {
                kickedSocket.disconnect(true);
            }

            // Update online users list for everyone
            io.emit('online users', Array.from(onlineUsers));
            
            console.log(`User ${userToKick} was kicked by admin ${currentUser}`);
        } else {
            console.log(`Failed to kick user ${userToKick} (not found or is admin)`);
        }
    });
  
    socket.on('chat message', (msg) => {
        if (!msg.trim()) return;

        io.emit('chat message', {
            username: currentUser,
            text: msg,
            time: new Date().toISOString().replace('T', ' ').slice(0, 19)
        });
    });

    socket.on('file message', (fileData) => {
        io.emit('file message', {
            username: currentUser,
            file: fileData,
            time: new Date().toISOString().replace('T', ' ').slice(0, 19)
        });
    });

    socket.on('typing', () => {
        socket.broadcast.emit('user typing', { username: currentUser });
    });

    socket.on('stop typing', () => {
        socket.broadcast.emit('user stop typing');
    });

    socket.on('disconnect', () => {
        if (currentUser) {
            if (adminSessionToken) {
                authenticatedAdmins.delete(adminSessionToken);
            }
            onlineUsers.delete(currentUser);
            io.emit('online users', Array.from(onlineUsers));
            io.emit('user left', {
                username: currentUser,
                time: new Date().toISOString().replace('T', ' ').slice(0, 19)
            });
        }
    });
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({
        status: 'error',
        message: 'Something broke!'
    });
});

// Thêm middleware để log các sự kiện quan trọng
io.use((socket, next) => {
    const time = new Date().toISOString().replace('T', ' ').slice(0, 19);
    console.log(`[${time}] New connection attempt`);
    next();
});

// Start server
const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log('Current time (UTC):', new Date().toISOString().replace('T', ' ').slice(0, 19));
});

// Graceful shutdown
process.on('SIGTERM', () => {
    http.close(() => {
        console.log('Server shutting down...');
        process.exit(0);
    });
});

// Clean up admin sessions periodically
setInterval(() => {
    authenticatedAdmins.clear();
}, 24 * 60 * 60 * 1000); // Clear every 24 hours
