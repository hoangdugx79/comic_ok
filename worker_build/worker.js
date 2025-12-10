
const axios = require('axios');
const path = require('path');
const fs = require('fs-extra');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const sharp = require('sharp');
const crypto = require('crypto');

// Kết nối Server
// Logic thông minh: Nếu vẫn là placeholder thì tự động dùng localhost
let SERVER_URL = process.argv[2];
if (!SERVER_URL) {
    const rawUrl = 'http://192.168.1.31:3001';
    if (rawUrl.includes('__HOST_' + 'IP__')) { // Hack chuỗi để tránh bị server replace đoạn check này
        console.log("⚠️ IP Placeholder detected (No injection). Defaulting to localhost.");
        SERVER_URL = 'http://localhost:3001';
    } else {
        SERVER_URL = rawUrl;
    }
}
const WORKER_ID = 'worker_' + crypto.randomBytes(4).toString('hex');
const POLL_INTERVAL = 2000;

console.log(`Initializing Worker ${WORKER_ID}...`);
console.log(`Connecting to Server API at ${SERVER_URL}`);

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
        const outName = `proc_${index}_${subIdx}.jpg`;
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
    const outName = `proc_${index}.jpg`;
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
    const s = `${w}x${h}`;
    const calcStep = (zoomTarget, zoomStart = 1.0) => ((Math.abs(zoomTarget - zoomStart) / frames).toFixed(7));
    switch (style) {
      case 'zoom_in': return `zoompan=z='min(zoom+${calcStep(1.5)},1.5)':d=${frames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${s}`;
      case 'pan_right': return `zoompan=z=1.2:x='x+2':y='ih/2-(ih/zoom/2)':d=${frames}:s=${s}`;
      case 'pan_left': return `zoompan=z=1.2:x='if(eq(on,1),iw/2,x-2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${s}`;
      case 'scroll_down': return `zoompan=z='min(zoom+${calcStep(1.1)},1.1)':d=${frames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${s}`;
      case 'manga_bw': return `hue=s=0,eq=contrast=1.2`;
      case 'sepia': return `colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131`;
      default: return `zoompan=z='min(zoom+${calcStep(1.05)},1.05)':d=${frames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${s}`;
    }
};

const processTask = async (taskData) => {
    const { jobId, images, config, musicUrl, title } = taskData;
    console.log(`>>> Processing Job ${jobId}: ${images.length} images`);

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
            const fileName = `raw_${String(i).padStart(3, '0')}${ext}`;
            const filePath = path.join(tempDir, fileName);
            try {
                const response = await axios({ url: images[i].url, responseType: 'stream' });
                const writer = fs.createWriteStream(filePath);
                response.data.pipe(writer);
                await new Promise((resolve, reject) => { writer.on('finish', resolve); writer.on('error', reject); });
                downloadedFiles.push(filePath);
            } catch (e) { console.error(`Err download img ${i}`); }
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
            fileContent += `file '${file.replace(/\\/g, '/')}'\n`; 
            fileContent += `duration ${duration}\n`;
        });
        fileContent += `file '${finalImageList[finalImageList.length - 1].replace(/\\/g, '/')}'\n`;
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
        
        await axios.post(`${SERVER_URL}/api/worker/submit-result/${jobId}`, videoBuffer, {
            headers: { 'Content-Type': 'video/mp4' },
            maxContentLength: Infinity,
            maxBodyLength: Infinity
        });
        console.log("✅ Upload complete!");
        await fs.remove(tempDir);

    } catch (error) {
        console.error("Task Failed:", error.message);
        await axios.post(`${SERVER_URL}/api/worker/report-error/${jobId}`, { error: error.message });
        await fs.remove(tempDir).catch(()=>{});
    }
};

const pollServer = async () => {
    try {
        const { data: task } = await axios.get(`${SERVER_URL}/api/worker/get-task?workerId=${WORKER_ID}`);
        if (task && task.jobId) await processTask(task);
    } catch (e) {
        if (e.code === 'ECONNREFUSED') console.log("❌ Server unavailable, retrying...");
        else console.error("Poll error:", e.message);
    }
    setTimeout(pollServer, POLL_INTERVAL);
};

console.log("🚀 Worker started. Polling for tasks...");
pollServer();
