// server.js (File Server Socket.IO Anda)

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);

const io = socketIo(server, {
  cors: {
    origin: "*", 
    methods: ["GET", "POST"]
  }
});

// --- Penyimpanan Pesan di Memori (Per Room) ---
const chatMessagesByRoom = {}; 
const MAX_MESSAGES_PER_ROOM = 500; 
const MESSAGE_LIFETIME_MS = 24 * 60 * 60 * 1000; 

const bannedUsers = new Set(); 
const activeUsernames = new Set(); 

function cleanOldMessages() { /* ... (fungsi pembersih tetap sama) ... */ }
setInterval(cleanOldMessages, 60 * 60 * 1000); 

// --- Kredensial Moderator (HARDCODED - HANYA UNTUK DEMO) ---
const MODERATORS = { 
  'admin': '123456', // GANTI password ini di produksi!
  'mod_beta': 'pass_beta456',
  'mod_gamma': 'pass_gamma789'
};

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });

// Middleware Socket.IO untuk Autentikasi dan Validasi Username Unik
// BARU: Mengambil 'password' dan 'role' dari `socket.handshake.auth`
io.use((socket, next) => {
  const { username, password, role, roomId } = socket.handshake.auth; 

  if (!username || username.trim() === '') { return next(new Error('Username tidak boleh kosong.')); }
  if (!roomId || roomId.trim() === '') { return next(new Error('Room ID tidak boleh kosong.')); } 

  const lowerCaseUsername = username.trim().toLowerCase();
  
  // Assign properties to socket object (akan digunakan di 'connection' event)
  socket.username = username; 
  socket.roomId = roomId; 
  socket.isModerator = false; // Default: bukan moderator
  socket.role = 'user'; // Default: user

  // Inisialisasi room jika belum ada dan tambahkan pesan sambutan
  if (!chatMessagesByRoom[roomId]) {
    chatMessagesByRoom[roomId] = [
        { 
            id: 'welcome-server-' + roomId, 
            username: 'Bola88Stream', 
            text: `Selamat datang di Live Chat Bola88 Room ${roomId}!`, 
            timestamp: new Date().toISOString(), 
            role: 'system' 
        }
    ];
  }

  // Cek apakah username sudah aktif (mengizinkan satu koneksi per username per server)
  let isReconnect = false;
  for (let [id, s] of io.of("/").sockets) {
      if (s.handshake.auth.username && s.handshake.auth.username.toLowerCase() === lowerCaseUsername && s.id !== socket.id) {
          isReconnect = true; 
          break;
      }
  }
  if (activeUsernames.has(lowerCaseUsername) && !isReconnect) {
      console.warn(`[Auth] Username '${username}' is already taken.`);
      return next(new Error('Username sudah digunakan. Silakan pilih username lain.'));
  }

  // Autentikasi moderator
  if (MODERATORS[username]) { // Cek apakah username ada di daftar moderator
    if (MODERATORS[username] === password) { // Cek passwordnya
      socket.isModerator = true; // Set isModerator ke true
      socket.role = 'moderator'; // Set role ke moderator
      activeUsernames.add(lowerCaseUsername); 
      console.log(`[Auth] Moderator ${username} connected to room ${roomId}: ${socket.id}`);
      return next(); 
    } else {
      console.warn(`[Auth] Failed moderator login attempt for username: ${username}`);
      return next(new Error('Autentikasi moderator gagal: Username atau Password salah!')); // Pesan error lebih spesifik
    }
  }
  
  // Untuk user biasa
  activeUsernames.add(lowerCaseUsername); 
  console.log(`[Auth] User ${username} connected to room ${roomId}: ${socket.id}`);
  next(); 
});

// Event handler utama untuk koneksi Socket.IO
io.on('connection', (socket) => {
  const clientUsername = socket.username; 
  const clientRole = socket.isModerator ? 'moderator' : 'user';
  const roomId = socket.roomId; 

  console.log(`[Connect] User connected: ${clientUsername} (${clientRole}) to Room: ${roomId} - ID: ${socket.id}`);

  socket.join(roomId);

  // Mengirim histori chat dari room yang spesifik
  socket.emit('chat history', chatMessagesByRoom[roomId] ? chatMessagesByRoom[roomId].slice() : []); 

  // BARU: Mengirim status moderator ke klien yang baru terhubung (selfAuthStatus)
  socket.emit('selfAuthStatus', { isModerator: socket.isModerator, username: clientUsername });

  // Event: 'chat message' (menerima pesan dari klien)
  socket.on('chat message', (data) => {
    const { text } = data; 
    const username = socket.username; 
    const currentRoomId = socket.roomId; 

    if (!username || !text || text.trim() === '') {
      socket.emit('system message', 'Pesan tidak boleh kosong.');
      return;
    }

    const lowerCaseUsername = username.toLowerCase();
    if (bannedUsers.has(lowerCaseUsername)) {
      socket.emit('system message', 'Anda telah diban dan tidak diizinkan mengirim pesan.');
      return;
    }

    const newMessage = {
      id: Date.now().toString() + Math.random().toString(36).substring(2, 9), 
      username: username, 
      text: text,
      timestamp: new Date().toISOString(), 
      role: socket.role // Sertakan role pengirim
    };

    chatMessagesByRoom[currentRoomId].push(newMessage);
    if (chatMessagesByRoom[currentRoomId].length > MAX_MESSAGES_PER_ROOM) {
      chatMessagesByRoom[currentRoomId].shift(); 
    }

    console.log(`[Chat] Room ${currentRoomId}: Message stored: (${clientRole}) ${username}: "${text}"`);
    io.to(currentRoomId).emit('chat message', newMessage); // Mengirim pesan HANYA ke klien di room yang SAMA
  });

  // --- Event: 'delete message' (untuk moderator) --- 
  socket.on('delete message', (messageId) => {
    if (!socket.isModerator) {
      socket.emit('system message', 'Anda tidak memiliki izin untuk menghapus pesan.');
      return;
    }
    const currentRoomId = socket.roomId;
    if (!chatMessagesByRoom[currentRoomId]) return; 

    const initialLength = chatMessagesByRoom[currentRoomId].length;
    const updatedMessages = chatMessagesByRoom[currentRoomId].filter(msg => msg.id !== messageId);
    chatMessagesByRoom[currentRoomId].splice(0, initialLength, ...updatedMessages); 

    if (chatMessagesByRoom[currentRoomId].length < initialLength) {
      console.log(`[Mod Action] Room ${currentRoomId}: Message ${messageId} deleted by moderator ${clientUsername}.`);
      io.to(currentRoomId).emit('message deleted', messageId); // Kirim ke klien di room yang sama
      socket.emit('system message', `Anda telah menghapus pesan dengan ID ${messageId}.`);
    } else {
      console.log(`[Mod Action] Message ${messageId} not found or already deleted in room ${currentRoomId}.`);
      socket.emit('system message', `Pesan dengan ID ${messageId} tidak ditemukan atau sudah terhapus.`);
    }
  });

  // --- Event: 'ban user' (untuk moderator) ---
  socket.on('ban user', (usernameToBan) => {
    if (!socket.isModerator) {
      socket.emit('system message', 'Anda tidak memiliki izin untuk memban pengguna.');
      return;
    }
    const lowerCaseUsernameToBan = usernameToBan.toLowerCase();
    const moderatorUsernames = Object.keys(MODERATORS).map(u => u.toLowerCase());
    if (moderatorUsernames.includes(lowerCaseUsernameToBan)) {
      socket.emit('system message', 'Tidak bisa memban moderator lain atau diri sendiri.');
      return;
    }

    if (!bannedUsers.has(lowerCaseUsernameToBan)) {
      bannedUsers.add(lowerCaseUsernameToBan);
      console.log(`[Mod Action] User ${usernameToBan} has been permanently banned by moderator ${clientUsername}.`);
      io.to(socket.roomId).emit('system message', `Pengguna ${usernameToBan} telah diban oleh moderator.`); 
      io.to(socket.roomId).emit('user banned', usernameToBan); // BARU: Emit event user diban ke room
      socket.emit('system message', `Anda telah memban pengguna ${usernameToBan}.`); 

      for (let [id, s] of io.of("/").sockets) {
        if (s.username && s.username.toLowerCase() === lowerCaseUsernameToBan && !s.isModerator) {
          s.emit('system message', `Anda telah diban dan tidak dapat mengirim pesan.`); 
          s.disconnect(true); 
          console.log(`[Mod Action] Disconnected banned user socket: ${id} (${usernameToBan}).`);
        }
      }
    } else { 
      socket.emit('system message', `Pengguna ${usernameToBan} sudah diban.`); 
    }
  });

  // --- Event: 'disconnect' (saat klien terputus) --- 
  socket.on('disconnect', () => {
    const lowerCaseUsername = socket.username.toLowerCase();
    if (activeUsernames.has(lowerCaseUsername)) {
      activeUsernames.delete(lowerCaseUsername);
    }
    console.log(`[Disconnect] User disconnected: ${socket.username} from Room: ${socket.roomId} - ID: ${socket.id}`);
  });
});

const PORT = process.env.PORT || 3001; 
server.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});