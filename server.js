require('dotenv').config();
const express = require('express');
const next = require('next');
const axios = require('axios');
const path = require('path');
const fs = require('fs-extra');
const cors = require('cors');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const uniqueSlug = require('unique-slug');
const sharp = require('sharp');
const crypto = require('crypto');
const http = require('http');
const { exec } = require('child_process');
const os = require('os');

sharp.cache(false);

const dev = process.env.NODE_ENV !== 'production';
const app = next({ dev });
const handle = app.getRequestHandler();

ffmpeg.setFfmpegPath(ffmpegPath);

const PORT = process.env.PORT || 3000;
const PUBLIC_BASE_URL = (() => {
    const envUrl = process.env.PUBLIC_BASE_URL;
    if (!envUrl) return null;
    const trimmed = envUrl.trim();
    if (!trimmed) return null;
    const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    return withProtocol.replace(/\/$/, '');
})();

const MUSIC_CACHE_DIR = path.join(__dirname, 'music_cache');
fs.ensureDirSync(MUSIC_CACHE_DIR);

const USERS_FILE = path.join(__dirname, 'users.json');
fs.ensureFile(USERS_FILE).then(() => {
    fs.readFile(USERS_FILE, 'utf8').then(data => {
        if (!data) fs.writeJson(USERS_FILE, []);
    }).catch(() => fs.writeJson(USERS_FILE, []));
});

const WORKER_BUILD_DIR = path.join(__dirname, 'worker_build');
fs.ensureDirSync(WORKER_BUILD_DIR);

const WORKER_PACKAGE_PATH = path.join(WORKER_BUILD_DIR, 'package.json');

const WORKER_PACKAGE_CONTENT = {
  name: 'worker',
  version: '1.0.0',
  main: 'worker.js',
  bin: 'worker.js',
  pkg: {
    scripts: [],
    assets: [
      "node_modules/sharp/**/*",
      "node_modules/@img/**/*",
      "node_modules/ffmpeg-static/**/*",
      "node_modules/axios/**/*"
    ]
  },
  dependencies: {
    axios: "^0.27.2",       // Bản cũ ổn định với PKG
    sharp: "0.32.6",       // Bản cũ ổn định với Node 16 PKG
    'fs-extra': 'latest',
    'fluent-ffmpeg': 'latest',
    'ffmpeg-static': 'latest',
    crypto: 'latest'
  }
};

fs.writeFileSync(WORKER_PACKAGE_PATH, JSON.stringify(WORKER_PACKAGE_CONTENT, null, 2));

const MANGA_MUSIC_LIBRARY = [
  { id: 'epic_battle', name: '1. Shonen Battle (Epic Rock)', url: 'https://incompetech.com/music/royalty-free/mp3-royaltyfree/Volatile%20Reaction.mp3', tag: 'Action' },
  { id: 'sad_emotional', name: '2. Sad Backstory (Piano/Violin)', url: 'https://incompetech.com/music/royalty-free/mp3-royaltyfree/Sad%20Trio.mp3', tag: 'Sad' },
  { id: 'tension_suspense', name: '3. Plot Twist (Suspense)', url: 'https://incompetech.com/music/royalty-free/mp3-royaltyfree/Oppressive%20Gloom.mp3', tag: 'Mystery' },
  { id: 'heroic_victory', name: '4. Hero Arrives (Orchestral)', url: 'https://incompetech.com/music/royalty-free/mp3-royaltyfree/Heroic%20Age.mp3', tag: 'Epic' },
  { id: 'comedy_funny', name: '5. Funny Moments (Slice of Life)', url: 'https://incompetech.com/music/royalty-free/mp3-royaltyfree/Monkeys%20Spinning%20Monkeys.mp3', tag: 'Fun' },
  { id: 'dark_villain', name: '6. Villain Theme (Dark/Creepy)', url: 'https://incompetech.com/music/royalty-free/mp3-royaltyfree/Impact%20Moderato.mp3', tag: 'Dark' },
  { id: 'training_montage', name: '7. Training Arc (Upbeat)', url: 'https://incompetech.com/music/royalty-free/mp3-royaltyfree/Take%20a%20Chance.mp3', tag: 'Motivational' },
  { id: 'japan_traditional', name: '8. Ancient Era (Shamisen/Koto)', url: 'https://incompetech.com/music/royalty-free/mp3-royaltyfree/Ishikari%20Lore.mp3', tag: 'Traditional' },
  { id: 'lofi_chill', name: '9. Reading Mode (Lofi Hip Hop)', url: 'https://incompetech.com/music/royalty-free/mp3-royaltyfree/Dream%20Culture.mp3', tag: 'Chill' },
  { id: 'horror_seinen', name: '10. Horror/Gore (Ambient)', url: 'https://incompetech.com/music/royalty-free/mp3-royaltyfree/Giant%20Wyrm.mp3', tag: 'Horror' },
  { id: 'fast_paced', name: '11. Speed Lines (Fast Drum&Bass)', url: 'https://incompetech.com/music/royalty-free/mp3-royaltyfree/Movement%20Proposition.mp3', tag: 'Fast' },
  { id: 'mystery_detective', name: '12. Investigation (Detective)', url: 'https://incompetech.com/music/royalty-free/mp3-royaltyfree/I%20Knew%20a%20Guy.mp3', tag: 'Jazz' },
  { id: 'fantasy_adventure', name: '13. New World (Fantasy)', url: 'https://incompetech.com/music/royalty-free/mp3-royaltyfree/Celtic%20Impulse.mp3', tag: 'Adventure' },
  { id: 'romance_cute', name: '14. Romance (Cute/Piano)', url: 'https://incompetech.com/music/royalty-free/mp3-royaltyfree/Touching%20Moments%20Two.mp3', tag: 'Romance' },
  { id: 'ending_credits', name: '15. Emotional Ending (Finale)', url: 'https://incompetech.com/music/royalty-free/mp3-royaltyfree/Sovereign.mp3', tag: 'Ending' }
];

const WORKER_SOURCE_CODE = `
const axios = require('axios');
const path = require('path');
const fs = require('fs-extra');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const crypto = require('crypto');

const ensureSharpRuntime = () => {
    if (!process.pkg) return;
    const execDir = path.dirname(process.execPath);
    const snapshotVendor = path.join(__dirname, 'node_modules', 'sharp', 'vendor');
    const runtimeVendor = path.join(execDir, 'sharp-vendor');
    try {
        if (!fs.existsSync(runtimeVendor)) {
            fs.copySync(snapshotVendor, runtimeVendor);
        }
    } catch (err) {
        console.error("Failed to copy sharp vendor files:", err);
    }
    const binaryName = \`sharp-\${process.platform}-\${process.arch}.node\`;
    const snapshotBinary = path.join(__dirname, 'node_modules', 'sharp', 'build', 'Release', binaryName);
    const runtimeBinary = path.join(execDir, binaryName);
    try {
        if (!fs.existsSync(runtimeBinary)) {
            fs.copyFileSync(snapshotBinary, runtimeBinary);
        }
    } catch (err) {
        console.error("Failed to extract sharp binary:", err);
    }
    process.env.SHARP_IGNORE_GLOBAL_LIBVIPS = '1';
    process.env.SHARP_DIST_BASE_URL = runtimeVendor.replace(/\\\\/g, '/');
    process.env.SHARP_LIBRARY_FILE = runtimeBinary.replace(/\\\\/g, '/');
};

ensureSharpRuntime();
const sharp = require('sharp');

// Kết nối Server
// Logic thông minh: Nếu vẫn là placeholder thì tự động dùng localhost
let SERVER_URL = process.argv[2];
if (!SERVER_URL) {
    const rawUrl = '__SERVER_URL__';
    if (rawUrl.includes('__SERVER_' + 'URL__')) { // Hack chuỗi để tránh bị server replace đoạn check này
        console.log("⚠️ IP Placeholder detected (No injection). Defaulting to localhost.");
        SERVER_URL = 'http://localhost:${PORT}';
    } else {
        SERVER_URL = rawUrl;
    }
}
const WORKER_ID = 'worker_' + crypto.randomBytes(4).toString('hex');
const POLL_INTERVAL = 2000;

console.log(\`Initializing Worker \${WORKER_ID}...\`);
console.log(\`Connecting to Server API at \${SERVER_URL}\`);

// --- 1. Fix FFmpeg Path in PKG ---
let finalFfmpegPath = ffmpegStatic;
if (process.pkg) {
    const workerDir = path.dirname(process.execPath);
    const destPath = path.join(workerDir, 'ffmpeg.exe');
    try {
        if (!fs.existsSync(destPath)) {
            console.log("Extracting FFmpeg from snapshot...");
            fs.copyFileSync(ffmpegStatic, destPath);
        }
        finalFfmpegPath = destPath;
    } catch (err) { console.error("FATAL: Could not extract FFmpeg:", err); }
}
try { ffmpeg.setFfmpegPath(finalFfmpegPath); } catch (e) {}

sharp.cache(false);

const processImageForStyle = async (inputPath, outputDir, index, style, videoW, videoH) => {
    const image = sharp(inputPath);
    const metadata = await image.metadata();
    const processedFiles = [];
    const targetAspect = videoW / videoH;
    const isTallImage = metadata.height > (metadata.width / targetAspect) * 1.5;
    const stylesNeedingSlicing = ['scroll_down', 'smart_crop', 'zoom_in'];
    
    if (isTallImage && stylesNeedingSlicing.includes(style)) {
      const segmentHeight = Math.floor(metadata.width / targetAspect);
      const overlap = Math.floor(segmentHeight * 0.15);
      let currentY = 0;
      let subIdx = 0;
      while (currentY < metadata.height) {
        let extractH = segmentHeight;
        if (currentY + extractH > metadata.height) extractH = metadata.height - currentY;
        if (extractH < segmentHeight * 0.3 && subIdx > 0) break;
        const outName = \`proc_\${index}_\${subIdx}.jpg\`;
        const outPath = path.join(outputDir, outName);
        await sharp({ create: { width: videoW, height: videoH, channels: 4, background: 'black' } })
        .composite([{ input: await image.clone().extract({ left: 0, top: currentY, width: metadata.width, height: extractH }).resize({ width: videoW, height: videoH, fit: 'contain', background: 'black' }).toBuffer() }])
        .toFile(outPath);
        processedFiles.push(outPath);
        currentY += (segmentHeight - overlap);
        subIdx++;
      }
      return processedFiles;
    }
    const outName = \`proc_\${index}.jpg\`;
    const outPath = path.join(outputDir, outName);
    let pipeline = image.clone();
    if ((style === 'smart_crop' || style === 'zoom_in') && !isTallImage) {
      await pipeline.resize(videoW, videoH, { fit: 'cover', position: 'center' }).toFile(outPath);
    } else if (style === 'simple_fit') {
      await pipeline.resize(videoW, videoH, { fit: 'contain', background: 'black' }).toFile(outPath);
    } else {
      const blurredBg = await image.clone().resize(videoW, videoH, { fit: 'cover' }).blur(40).modulate({ brightness: 0.7 }).toBuffer();
      const mainImage = await image.clone().resize(videoW, videoH, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
      await sharp(blurredBg).composite([{ input: mainImage }]).toFile(outPath);
    }
    processedFiles.push(outPath);
    return processedFiles;
};

const getMotionFilter = (style, w, h, duration) => {
    const fps = 30;
    const frames = duration * fps;
    const s = \`\${w}x\${h}\`;
    const calcStep = (zoomTarget, zoomStart = 1.0) => ((Math.abs(zoomTarget - zoomStart) / frames).toFixed(7));
    switch (style) {
      case 'zoom_in': return \`zoompan=z='min(zoom+\${calcStep(1.5)},1.5)':d=\${frames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=\${s}\`;
      case 'pan_right': return \`zoompan=z=1.2:x='x+2':y='ih/2-(ih/zoom/2)':d=\${frames}:s=\${s}\`;
      case 'pan_left': return \`zoompan=z=1.2:x='if(eq(on,1),iw/2,x-2)':y='ih/2-(ih/zoom/2)':d=\${frames}:s=\${s}\`;
      case 'scroll_down': return \`zoompan=z='min(zoom+\${calcStep(1.1)},1.1)':d=\${frames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=\${s}\`;
      case 'manga_bw': return \`hue=s=0,eq=contrast=1.2\`;
      case 'sepia': return \`colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131\`;
      default: return \`zoompan=z='min(zoom+\${calcStep(1.05)},1.05)':d=\${frames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=\${s}\`;
    }
};

const processTask = async (taskData) => {
    const { jobId, images, config, musicUrl, title } = taskData;
    console.log(\`>>> Processing Job \${jobId}: \${images.length} images\`);

    const rootDir = process.cwd(); 
    const tempDir = path.join(rootDir, 'temp_worker', jobId);
    const processedDir = path.join(tempDir, 'processed');
    const outputVideoPath = path.join(tempDir, 'output.mp4');

    try {
        await fs.ensureDir(tempDir);
        await fs.ensureDir(processedDir);
        const isPortrait = config.ratio === '9:16';
        const outW = isPortrait ? 720 : 1280;
        const outH = isPortrait ? 1280 : 720;
        const duration = config?.durationPerImg || 3;
        const style = config?.style || 'blur_bg';

        const downloadedFiles = [];
        for (let i = 0; i < images.length; i++) {
            const cleanUrl = images[i].url.split('?')[0];
            let ext = path.extname(cleanUrl) || '.jpg';
            if(ext.length > 5) ext = '.jpg'; 
            const fileName = \`raw_\${String(i).padStart(3, '0')}\${ext}\`;
            const filePath = path.join(tempDir, fileName);
            try {
                const response = await axios({ url: images[i].url, responseType: 'stream' });
                const writer = fs.createWriteStream(filePath);
                response.data.pipe(writer);
                await new Promise((resolve, reject) => { writer.on('finish', resolve); writer.on('error', reject); });
                downloadedFiles.push(filePath);
            } catch (e) { console.error(\`Err download img \${i}\`); }
        }

        let finalImageList = [];
        for (let i = 0; i < downloadedFiles.length; i++) {
            const processed = await processImageForStyle(downloadedFiles[i], processedDir, i, style, outW, outH);
            finalImageList = finalImageList.concat(processed);
        }
        if (finalImageList.length === 0) throw new Error("No images processed");

        let audioPath = null;
        if (musicUrl && musicUrl.startsWith('http')) {
            const musicPath = path.join(tempDir, 'bgm.mp3');
            try {
                const audioRes = await axios({ url: musicUrl, responseType: 'stream' });
                const audioWriter = fs.createWriteStream(musicPath);
                audioRes.data.pipe(audioWriter);
                await new Promise((resolve, reject) => { audioWriter.on('finish', resolve); audioWriter.on('error', reject); });
                audioPath = musicPath;
            } catch (err) { console.error("Music download error:", err.message); }
        }

        const listFilePath = path.join(tempDir, 'images.txt');
        let fileContent = '';
        finalImageList.forEach(file => {
            fileContent += \`file '\${file.replace(/\\\\/g, '/')}'\\n\`; 
            fileContent += \`duration \${duration}\\n\`;
        });
        fileContent += \`file '\${finalImageList[finalImageList.length - 1].replace(/\\\\/g, '/')}'\\n\`;
        await fs.writeFile(listFilePath, fileContent);

        console.log("Running FFmpeg...");
        await new Promise((resolve, reject) => {
            let command = ffmpeg(listFilePath).inputOptions(['-f concat', '-safe 0']);
            if (audioPath) command.input(audioPath).inputOptions(['-stream_loop -1']);
            const outOptions = ['-c:v libx264', '-pix_fmt yuv420p', '-r 30', '-movflags +faststart'];
            if (audioPath) { outOptions.push('-c:a aac'); outOptions.push('-shortest'); outOptions.push('-map 0:v'); outOptions.push('-map 1:a'); }
            command.outputOptions(outOptions)
                .complexFilter([getMotionFilter(style, outW, outH, duration)])
                .save(outputVideoPath).on('end', resolve).on('error', reject);
        });

        console.log("Video generated. Uploading to Server...");
        const videoBuffer = await fs.readFile(outputVideoPath);
        
        await axios.post(\`\${SERVER_URL}/api/worker/submit-result/\${jobId}\`, videoBuffer, {
            headers: { 'Content-Type': 'video/mp4' },
            maxContentLength: Infinity,
            maxBodyLength: Infinity
        });
        console.log("✅ Upload complete!");
        await fs.remove(tempDir);

    } catch (error) {
        console.error("Task Failed:", error.message);
        await axios.post(\`\${SERVER_URL}/api/worker/report-error/\${jobId}\`, { error: error.message });
        await fs.remove(tempDir).catch(()=>{});
    }
};

const pollServer = async () => {
    try {
        const { data: task } = await axios.get(\`\${SERVER_URL}/api/worker/get-task?workerId=\${WORKER_ID}\`);
        if (task && task.jobId) await processTask(task);
    } catch (e) {
        if (e.code === 'ECONNREFUSED') console.log("❌ Server unavailable, retrying...");
        else console.error("Poll error:", e.message);
    }
    setTimeout(pollServer, POLL_INTERVAL);
};

console.log("🚀 Worker started. Polling for tasks...");
pollServer();
`;

const activeWorkers = new Map();
const jobToWorker = new Map();
const globalStats = { totalJobs: 0 };
const activeSessions = new Map();

const hashPassword = (password, salt) => {
    return crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
};

const validatePassword = (password, hash, salt) => {
    const checkHash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
    return checkHash === hash;
};

const getUsers = async () => {
    try {
        return await fs.readJson(USERS_FILE);
    } catch (e) {
        return [];
    }
};

const saveUsers = async (users) => {
    await fs.writeJson(USERS_FILE, users, { spaces: 2 });
};

const getLocalExternalIP = () => {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return 'localhost';
};

const getWorkerServerUrl = () => {
    if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL;
    const localIP = getLocalExternalIP();
    return `http://${localIP}:${PORT}`;
};

const requireUserAuth = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Yêu cầu đăng nhập.' });
    }
    const token = authHeader.split(' ')[1];
    const sessionUser = activeSessions.get(token);
    
    if (!sessionUser) {
        return res.status(401).json({ error: 'Phiên đăng nhập không hợp lệ hoặc đã hết hạn.' });
    }

    const users = await getUsers();
    const currentUser = users.find(u => u.id === sessionUser.id);
    
    if (!currentUser) {
        activeSessions.delete(token);
        return res.status(401).json({ error: 'Tài khoản không tồn tại.' });
    }

    if (currentUser.status === 'banned') {
        activeSessions.delete(token);
        return res.status(403).json({ error: 'Tài khoản của bạn đã bị khóa.' });
    }

    if (currentUser.status === 'pending') {
        return res.status(403).json({ error: 'Tài khoản đang chờ Admin duyệt.' });
    }

    req.user = currentUser;
    next();
};

setInterval(() => {
  const now = Date.now();
  for (const [id, info] of activeWorkers.entries()) {
    if (now - info.lastSeen > 10000 && info.status !== 'busy') {
      activeWorkers.delete(id);
    }
  }
}, 5000);

app.prepare().then(() => {
  const server = express();
  server.use(express.json({ limit: '500mb' }));
  server.use(express.raw({ type: 'video/mp4', limit: '500mb' })); 
  server.use(cors());

  const jobQueue = [];
  const pendingResponses = new Map();

  server.post('/api/auth/register', async (req, res) => {
      const { username, password } = req.body;
      if (!username || !password) return res.status(400).json({ error: 'Thiếu thông tin.' });
      
      const users = await getUsers();
      if (users.find(u => u.username === username)) {
          return res.status(400).json({ error: 'Tên đăng nhập đã tồn tại.' });
      }

      const salt = crypto.randomBytes(16).toString('hex');
      const hashedPassword = hashPassword(password, salt);
      
      const newUser = {
          id: uniqueSlug(),
          username,
          salt,
          passwordHash: hashedPassword,
          status: 'pending', // Mặc định chờ duyệt
          createdAt: Date.now()
      };
      
      users.push(newUser);
      await saveUsers(users);
      
      res.json({ success: true, message: 'Đăng ký thành công. Vui lòng chờ Admin duyệt.' });
  });

  server.post('/api/auth/login', async (req, res) => {
      const { username, password } = req.body;
      const users = await getUsers();
      const user = users.find(u => u.username === username);

      if (!user) return res.status(400).json({ error: 'Sai tên đăng nhập hoặc mật khẩu.' });
      if (!validatePassword(password, user.passwordHash, user.salt)) {
          return res.status(400).json({ error: 'Sai tên đăng nhập hoặc mật khẩu.' });
      }
      
      if (user.status === 'banned') return res.status(403).json({ error: 'Tài khoản đã bị khóa.' });
      if (user.status === 'pending') return res.status(403).json({ error: 'Tài khoản đang chờ duyệt.' });

      const token = crypto.randomBytes(32).toString('hex');
      activeSessions.set(token, { id: user.id, username: user.username });

      res.json({ success: true, token, username: user.username });
  });

  server.get('/api/worker/get-task', (req, res) => {
    const { workerId } = req.query;
    
    if (workerId) {
      if (!activeWorkers.has(workerId)) {
        activeWorkers.set(workerId, { id: workerId, status: 'idle', lastSeen: Date.now() });
      } else {
        const w = activeWorkers.get(workerId);
        if (w.status !== 'busy') {
            activeWorkers.set(workerId, { ...w, status: 'idle', lastSeen: Date.now() });
        } else {
            activeWorkers.set(workerId, { ...w, lastSeen: Date.now() });
        }
      }
    }

    if (jobQueue.length > 0) {
        const job = jobQueue.shift();
        console.log(`[Dispatcher] Sending Job ${job.jobId} to Worker ${workerId}`);
        
        if (workerId) {
            activeWorkers.set(workerId, { id: workerId, status: 'busy', lastSeen: Date.now() });
            jobToWorker.set(job.jobId, workerId);
        }
        
        return res.json(job.data);
    }
    res.json(null);
  });

  server.post('/api/worker/submit-result/:jobId', express.raw({ type: '*/*', limit: '500mb' }), (req, res) => {
      const { jobId } = req.params;
      const videoBuffer = req.body;
      console.log(`✅ Received result for Job ${jobId}`);

      globalStats.totalJobs = (globalStats.totalJobs || 0) + 1;
      
      const workerId = jobToWorker.get(jobId);
      if (workerId && activeWorkers.has(workerId)) {
          const w = activeWorkers.get(workerId);
          activeWorkers.set(workerId, { ...w, status: 'idle', lastSeen: Date.now() });
          jobToWorker.delete(jobId);
      }

      const clientRes = pendingResponses.get(jobId);
      if (clientRes) {
          const { res: userRes, jobTitle } = clientRes;
          const seoFilename = `${jobTitle}.mp4`;
          userRes.setHeader('Content-Type', 'video/mp4');
          userRes.setHeader('Content-Disposition', `attachment; filename="${seoFilename}"`);
          userRes.send(videoBuffer);
          pendingResponses.delete(jobId);
          res.json({ success: true });
      } else {
          res.status(404).json({ error: 'Client disconnected' });
      }
  });

  server.post('/api/worker/report-error/:jobId', (req, res) => {
      const { jobId } = req.params;
      const { error } = req.body;
      console.error(`❌ Job ${jobId} failed: ${error}`);

      const workerId = jobToWorker.get(jobId);
      if (workerId && activeWorkers.has(workerId)) {
          const w = activeWorkers.get(workerId);
          activeWorkers.set(workerId, { ...w, status: 'idle', lastSeen: Date.now() });
          jobToWorker.delete(jobId);
      }

      const clientRes = pendingResponses.get(jobId);
      if (clientRes) {
          clientRes.res.status(500).json({ error: error });
          pendingResponses.delete(jobId);
      }
      res.json({ received: true });
  });

  server.post('/api/create-video', requireUserAuth, async (req, res) => {
    const { images, config, musicUrl, title } = req.body; 
    if (!images || images.length === 0) return res.status(400).json({ error: 'Không có ảnh đầu vào' });
    req.setTimeout(600000); 

    const jobId = uniqueSlug();
    let finalMusicUrl = musicUrl;
    if (musicUrl && !musicUrl.startsWith('http')) {
        const foundTrack = MANGA_MUSIC_LIBRARY.find(t => t.id === musicUrl);
        if (foundTrack) finalMusicUrl = foundTrack.url;
    }
    let seoFilename = title ? title.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-zA-Z0-9\s-]/g, '').trim().replace(/\s+/g, '-') : 'video';

    pendingResponses.set(jobId, { res, jobTitle: seoFilename });
    jobQueue.push({ jobId, data: { jobId, images, config, musicUrl: finalMusicUrl, title } });
    console.log(`Job ${jobId} added to queue by User: ${req.user.username}`);
  });

  server.post('/api/fetch-images', requireUserAuth, async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL is required' });
    try {
      const urlObj = new URL(url);
      const comicId = urlObj.searchParams.get('comicId');
      const episodeNum = urlObj.searchParams.get('read') || '1';
      const baseUrl = urlObj.origin;
      if (!comicId) return res.status(400).json({ error: 'Không tìm thấy Comic ID.' });
      let userId = null;
      try {
        const { data: listData } = await axios.get(`${baseUrl}/api/public/comics?limit=100`);
        if (listData?.comics) {
          const target = listData.comics.find(c => c.id === comicId);
          if (target) userId = target.userId;
        }
      } catch (e) {}
      if (!userId) {
         try {
           const { data: html } = await axios.get(url);
           const userMatch = html.match(/users\/([a-zA-Z0-9_-]+)\/comic/);
           if (userMatch) userId = userMatch[1];
         } catch (e) {}
      }
      if (!userId) return res.status(404).json({ error: 'Không tìm thấy User ID tác giả.' });
      const readApiUrl = `${baseUrl}/api/public/comics/${userId}/${comicId}/read/${episodeNum}`;
      const { data: readData } = await axios.get(readApiUrl);
      let images = [];
      if (readData) {
        if (Array.isArray(readData.pages)) images = readData.pages.map(p => p.url || p);
        else if (Array.isArray(readData.images)) images = readData.images;
        else if (Array.isArray(readData)) images = readData.images;
      }
      const cleanImages = images.map((url, index) => ({ url: url.startsWith('http') ? url : `${baseUrl}${url}`, alt: `Page ${index + 1}` }));
      if (cleanImages.length === 0) return res.status(404).json({ error: 'Không tìm thấy ảnh.' });
      res.json({ success: true, count: cleanImages.length, images: cleanImages });
    } catch (error) { res.status(500).json({ error: error.message }); }
  });

  server.get('/api/music-library', (req, res) => {
    res.json({ success: true, music: MANGA_MUSIC_LIBRARY });
  });

  server.post('/api/admin/login', (req, res) => {
    const { username, password } = req.body;
    if (username === 'admin' && password === '999') {
      const token = 'admin_token_' + crypto.randomBytes(8).toString('hex');
      return res.json({ success: true, token });
    }
    return res.status(401).json({ success: false, message: 'Sai thông tin đăng nhập' });
  });

  const checkAdminAuth = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer admin_token_')) {
      next();
    } else {
      res.status(401).json({ error: 'Unauthorized' });
    }
  };

  server.get('/api/admin/stats', checkAdminAuth, (req, res) => {
    const workers = Array.from(activeWorkers.values());
    const queue = jobQueue.map(j => ({
      jobId: j.jobId,
      data: { title: j.data.title }
    }));
    
    res.json({
      workers,
      queue,
      stats: globalStats
    });
  });

  server.get('/api/admin/users', checkAdminAuth, async (req, res) => {
      const users = await getUsers();
      const safeUsers = users.map(u => ({
          id: u.id,
          username: u.username,
          status: u.status,
          createdAt: u.createdAt
      }));
      res.json({ users: safeUsers });
  });

  server.post('/api/admin/user-action', checkAdminAuth, async (req, res) => {
      const { userId, action } = req.body;
      let users = await getUsers();
      const userIdx = users.findIndex(u => u.id === userId);
      
      if (userIdx === -1) return res.status(404).json({ error: 'User not found' });

      if (action === 'delete') {
          users.splice(userIdx, 1);
      } else if (action === 'approve') {
          users[userIdx].status = 'active';
      } else if (action === 'ban') {
          users[userIdx].status = 'banned';
      } else {
          return res.status(400).json({ error: 'Invalid action' });
      }

      await saveUsers(users);
      res.json({ success: true });
  });

  server.get('/api/download-worker', async (req, res) => {
    try {
        const buildDir = path.join(__dirname, 'worker_build');
        await fs.ensureDir(buildDir);
        const workerJsPath = path.join(buildDir, 'worker.js');
        const outputExePath = path.join(buildDir, 'worker.exe');
        
        const workerServerUrl = getWorkerServerUrl();
        console.log(`Injecting Worker Base URL: ${workerServerUrl}`);
        
        const finalWorkerCode = WORKER_SOURCE_CODE.replace(/__SERVER_URL__/g, workerServerUrl);
        
        await fs.writeFile(workerJsPath, finalWorkerCode);
        
        console.log("Building worker.exe (API Version)...");
        console.log("Installing dependencies...");

        exec('npm install', { cwd: buildDir }, (installErr) => {
             if (installErr) {
                 console.error("Npm install failed:", installErr);
                 return res.status(500).json({ error: 'Failed to install worker dependencies.' });
             }
             exec(`npx pkg . --targets node16-win-x64 --output worker.exe --compress GZip --public`, { cwd: buildDir }, (error, stdout, stderr) => {
                if (error) {
                    console.error(`Build error: ${error.message}`);
                    return res.status(500).json({ error: 'Build failed', details: stderr });
                }
                if (fs.existsSync(outputExePath)) {
                     const safeName = workerServerUrl.replace(/(^https?:\/\/)|[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'worker';
                     res.download(outputExePath, `worker_${safeName}.exe`);
                } else {
                    res.status(500).json({ error: 'Output file not found after build.' });
                }
            });
        });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: e.message });
    }
  });

  server.all('*', (req, res) => handle(req, res));

  server.listen(PORT, (err) => {
    if (err) throw err;
    const localIP = getLocalExternalIP();
    const workerServerUrl = getWorkerServerUrl();
    console.log(`> Server running on:`);
    console.log(`  - Local:   http://localhost:${PORT}`);
    console.log(`  - Network: http://${localIP}:${PORT}`);

    try {
        const buildDir = path.join(__dirname, 'worker_build');
        fs.ensureDirSync(buildDir);
        const initialWorkerCode = WORKER_SOURCE_CODE.replace(/__SERVER_URL__/g, workerServerUrl);
        fs.writeFileSync(path.join(buildDir, 'worker.js'), initialWorkerCode);
        console.log(`> [Auto-Fix] Prepared worker.js in 'worker_build' with base URL: ${workerServerUrl}`);
    } catch (e) {
        console.error("> [Auto-Fix] Failed to pre-write worker.js:", e.message);
    }
    
    console.log(`> Download Worker at: ${workerServerUrl}/api/download-worker`);
  });
});

