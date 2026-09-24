# Mehrspieler-Tests

Spielt das Spiel mit mehreren echten Browserfenstern durch: echte WebRTC-Verbindungen,
echtes Aufnehmen (Fake-Mikro), echte Premiere und Bewertung. Gehört **nicht** zur Website
(`tools/` wird beim Deploy ausgelassen).

## Einmalig

```bash
cd tools/multiplayer-test
npm install
node prepare.cjs          # Testvideo + zwei Mini-Packs nach assets/
```

Playwright/Chromium muss vorhanden sein (in Claude-Cloud-Umgebungen ist es vorinstalliert).

## Starten

```bash
node scenarios.cjs                    # alle Szenarien (~15–20 Minuten)
ONLY=team3,duel node scenarios.cjs    # nur bestimmte
```

Szenarien: `free3` (3 Spieler, Mehrfachrolle, Zuschauer), `match` (2 Runden bis Finale),
`br` (Battle Royale bis Champion), `duel`, `team3` (2 gegen 1), `teamleave` (Spieler geht
mitten in der Aufnahme), `handoff` / `matchhandoff` (Host weitergeben, neuer Host führt die
Runde), `pack` / `packogv` (lokale Packs), `blind`, `daily` (Szene des Tages laden),
`latejoin`, `kick`, `drop` (Verbindungsabbruch + automatisches Wiederverbinden),
`ownvideo` (eigenes Video, Echtzeit-Aufnahme), `ttt` (TicTacToe in der Warte-Arena).

Jedes Szenario gibt JSON aus (`ok`, Ergebnis-Texte, Konsolenfehler aller Fenster);
am Ende steht eine Zeile `SUMMARY`.

## Wie es funktioniert

- Ein lokaler PeerJS-Server (Port 9000) ersetzt `0.peerjs.com`; `window.Peer` wird im
  Browser darauf umgebogen.
- Alle Anfragen an `synchron-studio.github.io`, jsDelivr und GitHub Raw werden aus dem
  Repo beantwortet — das Spiel läuft also unter seiner echten Adresse, inklusive CDN-Logik.
- Chromium in Test-Umgebungen kann kein H.264: Szenen-MP4 werden beim ersten Abruf mit
  ffmpeg in kleine WebM umgewandelt (`webm-cache/`).
- Für Match/Battle Royale werden nur kurze Szenen ausgewürfelt, damit Premieren schnell sind.
