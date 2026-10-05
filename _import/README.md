# 🎬 Szenen hier hochladen → kommen automatisch ins Spiel

1. Im **Szenen-Editor** die Szene fertig machen und **„Export Scene (.zip)“** klicken.
2. Hier auf GitHub in diesem Ordner oben rechts **„Add file“ → „Upload files“** klicken.
3. Das ZIP (unverändert, nicht entpacken!) ins Fenster ziehen → unten **„Commit changes“**.
4. Fertig. Nach ca. **3–5 Minuten** ist die Szene im Spiel (Seite mit Strg+F5 neu laden).

**Wie sehe ich, ob es geklappt hat?** Oben auf **„Actions“** klicken → Lauf **„Szenen importieren“**:
- ✅ grüner Haken = eingebaut (in der Zusammenfassung steht, was genau)
- ❌ rotes Kreuz = nicht eingebaut. Der Grund steht in der Zusammenfassung **und** in
  `_import/fehlgeschlagen/<name> - FEHLER.txt`. Fehler beheben, ZIP nochmal hier hochladen.

**Gleiche Szene nochmal hochladen** (gleiche Szenen-ID) = die alte Version wird ersetzt.

**Grenze:** GitHub nimmt beim Hochladen über die Website höchstens **25 MB pro Datei**.
Ist das ZIP größer, den Ordner in Google Drive legen und Claude Bescheid sagen.

Technik: `.github/workflows/import-scenes.yml` + `tools/import-scene.cjs`.
