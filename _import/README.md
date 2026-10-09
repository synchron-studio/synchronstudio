# 🎬 Szenen hier hochladen → kommen automatisch ins Spiel

1. ZIP (oder RAR/7z) besorgen — **beides geht**:
   - aus dem **Szenen-Editor**: **„Export Scene (.zip)“**
   - ein **Choicer-Voicer-Pack** (Ordner mit `_pack_info.ini`, `dub_video.ogv`, `_backing_track`, Zeilen als `.txt`/`.ini` + `.wav`) — wird automatisch umgewandelt
2. Hier auf GitHub in diesem Ordner oben rechts **„Add file“ → „Upload files“** klicken.
3. Das ZIP (unverändert, nicht entpacken!) ins Fenster ziehen → unten **„Commit changes“**.
4. Fertig. Nach ca. **3–5 Minuten** ist die Szene im Spiel (Seite mit Strg+F5 neu laden).

**Noch einfacher bei GameBanana-Packs:** Datei `_import/links.txt` anlegen (Add file → Create new file),
pro Zeile einen Link wie `https://gamebanana.com/mods/724620` → „Commit changes“. GitHub lädt die Packs
selbst herunter (auch RAR/7z und über 25 MB) und baut sie ein; die Liste wird danach automatisch geleert.

**Wie sehe ich, ob es geklappt hat?** Oben auf **„Actions“** klicken → Lauf **„Szenen importieren“**:
- ✅ grüner Haken = eingebaut (in der Zusammenfassung steht, was genau)
- ❌ rotes Kreuz = nicht eingebaut. Der Grund steht in der Zusammenfassung **und** in
  `_import/fehlgeschlagen/<name> - FEHLER.txt`. Fehler beheben, ZIP nochmal hier hochladen.

**Deutsch & Englisch:** Fehlt eine Sprache, wird sie beim Einbauen automatisch übersetzt (maschinell) —
englische Zeilen bekommen eine deutsche Fassung, deutsche Zeilen eine englische.

**Gleiche Szene nochmal hochladen** (gleiche Szenen-ID) = die alte Version wird ersetzt.

**Grenze:** GitHub nimmt beim Hochladen über die Website höchstens **25 MB pro Datei**.
Ist das ZIP größer, den Ordner in Google Drive legen und Claude Bescheid sagen.

Technik: `.github/workflows/import-scenes.yml` + `tools/import-scene.cjs`.
