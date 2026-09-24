// Test-Dateien erzeugen (einmalig): Testvideo + zwei Mini-Packs (MP4 und OGV).
// Braucht nur ffmpeg-static und jszip aus package.json.
const fs = require('fs'), path = require('path'), cp = require('child_process');
const JSZip = require('jszip');
const FFMPEG = require('ffmpeg-static');
const OUT = path.join(__dirname, 'assets');
fs.mkdirSync(OUT, { recursive: true });
const ff = (args) => cp.execFileSync(FFMPEG, ['-y', '-loglevel', 'error', ...args]);
const tmp = (n) => path.join(OUT, n);

// 12 s Testbild mit Ton: 1 s Piepen, 1 s Pause (wie „Sprechpausen“)
ff(['-f', 'lavfi', '-i', 'testsrc=duration=12:size=640x360:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=12',
  '-af', "volume='if(lt(mod(t,2),1),1,0)':eval=frame", '-c:v', 'libvpx', '-b:v', '600k', '-c:a', 'libopus', '-shortest', tmp('test.webm')]);
ff(['-f', 'lavfi', '-i', 'sine=frequency=110:duration=12', '-ac', '1', '-ar', '22050', tmp('backing.wav')]);
ff(['-f', 'lavfi', '-i', 'sine=frequency=880:duration=1.5', '-ac', '1', '-ar', '22050', tmp('line.wav')]);
ff(['-i', tmp('test.webm'), '-c:v', 'libtheora', '-q:v', '5', '-c:a', 'libvorbis', tmp('dub_video.ogv')]);

async function pack(videoName, videoFile, outName) {
  const z = new JSZip();
  z.file('_pack_info.ini', '[data]\n\ntitle="Test Pack"\nicon="_icon.png"\nauthors=["Test"]\nreadme="Testpack"\npreselected_dub_characters=["Test Hero"]\n');
  z.file('_backing_track.wav', fs.readFileSync(tmp('backing.wav')));
  z.file(videoName, fs.readFileSync(videoFile));
  z.file('01_test_hero.ini', '[data]\n\ncaption="First line"\nimage="default.png"\ndub_timestamps=[0.500]\ndub_characters=["Test Hero"]\n');
  z.file('01_test_hero.wav', fs.readFileSync(tmp('line.wav')));
  z.file('02_test_hero.ini', '[data]\n\ncaption="Second line"\nimage="default.png"\ndub_timestamps=[6.000]\ndub_characters=["Test Hero"]\n');
  z.file('02_test_hero.wav', fs.readFileSync(tmp('line.wav')));
  fs.writeFileSync(path.join(OUT, outName), await z.generateAsync({ type: 'nodebuffer', compression: 'STORE' }));
}
(async () => {
  // Chromium kann kein H.264 — das „MP4“ im Test-Pack ist deshalb WebM-Inhalt (Browser erkennt das am Inhalt)
  await pack('dub_video.mp4', tmp('test.webm'), 'pack_mp4.zip');
  await pack('dub_video.ogv', tmp('dub_video.ogv'), 'pack_ogv.zip');
  console.log('Test-Dateien liegen in', OUT);
})();
