# Daily meds

Track daily medications, symptoms, food and notes, with monthly and yearly summaries.
Works offline and can be installed on your phone's home screen.

Allows for export of data to look for trends with help from AI.

## Put it online with GitHub Pages

1. Create a new repository on GitHub (for example `daily-meds`).
2. Upload everything in this folder (`index.html`, `manifest.webmanifest`, `sw.js`, the icon files, this README).
3. In the repo, go to **Settings → Pages**, set **Source** to "Deploy from a branch", pick `main` and `/ (root)`, and save.
4. After a minute your app is at `https://<your-username>.github.io/daily-meds/`.

## Install it on your phone (Samsung / Android)

Open the link in Chrome or Samsung Internet, open the browser menu, and tap
**Install app** or **Add to Home screen**. It opens full-screen like a normal app
and works without internet.

## Install it on iPhone

Open the Safari app on your iPhone and go to the website you want to save. Tap the Share button (the square with an arrow pointing upward at the bottom of the screen). Scroll down the list of options and tap Add to Home Screen. If you do not see it, scroll to the bottom, tap Edit Actions, and then add Add to Home Screen. Type a name for your web app shortcut if you want to change it. Turn on the Open as Web App toggle to make it run in a full-screen, standalone view. Tap Add in the top-right corner.

## Your data

Everything is stored on the device in the browser's storage. Nothing is sent anywhere.
Use **Save backup** on the Medications tab before changing phones, uninstalling,
or clearing browser data, then **Restore from backup** on the new device.

## Updating the app

After you change `index.html`, open `sw.js` and bump `CACHE` (for example `daily-meds-v2`)
so installed copies pick up the new version.
