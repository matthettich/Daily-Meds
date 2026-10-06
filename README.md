# Daily meds

A simple medication checklist that gives you a fresh list every day.
Works offline and can be installed on your phone's home screen.

## Put it online with GitHub Pages

1. Create a new repository on GitHub (for example `daily-meds`).
2. Upload everything in this folder (`index.html`, `manifest.webmanifest`, `sw.js`, the icon files, this README).
3. In the repo, go to **Settings → Pages**, set **Source** to "Deploy from a branch", pick `main` and `/ (root)`, and save.
4. After a minute your app is at `https://<your-username>.github.io/daily-meds/`.

## Install it on your phone (Samsung / Android)

Open the link in Chrome or Samsung Internet, open the browser menu, and tap
**Install app** or **Add to Home screen**. It opens full-screen like a normal app
and works without internet.

## Your data

Everything is stored on the device in the browser's storage. Nothing is sent anywhere.
Use **Save backup** on the Medications tab before changing phones, uninstalling,
or clearing browser data, then **Restore from backup** on the new device.

## Updating the app

After you change `index.html`, open `sw.js` and bump `CACHE` (for example `daily-meds-v2`)
so installed copies pick up the new version.
