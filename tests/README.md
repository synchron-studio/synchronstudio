# Reliability checks

Run `npm ci` followed by `npm test` from the repository root. The Pages workflow runs these checks before publishing.

The suite boots the complete game in jsdom with mocked browser media APIs and Peer connections, and tests the real loading and recording control flow. Separate tests cover download stalls/cancellation, seek timeouts, readiness, transfer integrity, speech bitrate selection, and scene asset references. Media files need not be downloaded in a sparse checkout; their paths are checked against Git's index.

## Browser validation for 9.16.0

Also checked in Chrome using a real video element, Web Audio and MediaRecorder with a synthetic microphone:

- Desktop viewport: 1365 × 900; touch/mobile viewport: 390 × 844.
- Scene preload, entering the recording booth, recording a line and decoding the saved take.
- Premiere playback and a completed MP4 capture in both viewport sizes.
- Two real PeerJS peers over local WebRTC: transferred a 68,434-byte video and a 1 MB binary track, preserving every byte and the volume/pan metadata.
- No uncaught JavaScript errors or horizontal overflow in these flows.
- Opus test takes shrank from roughly 25 KB to 13 KB for the same 1.5-second input.

These checks do not emulate a physical iPhone, mobile operating-system interruptions, or a multi-user session across separate residential/mobile networks. Repeat those device/network checks when changing WebRTC, Safari playback, or microphone recovery.
