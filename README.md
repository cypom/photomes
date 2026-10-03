# Infinite Canvas

3D 無限畫布（Three.js，無需打包）。拖曳平移、滾輪／雙指縮放推進、WASD + Q/E 鍵盤移動。

## 本機預覽
ES Module 需透過 HTTP 開啟，不能直接雙擊 index.html：

    npx serve .        # 或 python3 -m http.server

## 部署到 GitHub Pages
1. 把這個資料夾的內容推到 repo 根目錄
2. Settings → Pages → Source 選 `main` / `(root)` → Save
3. 幾分鐘後即可在 `https://<帳號>.github.io/<repo>/` 開啟

## 換成自己的照片
1. 照片放進 `photos/`
2. 在 `main.js` 頂部設定：

       const PHOTOS = ["photos/01.jpg", "photos/02.jpg"];

照片數量不足時會自動循環；圖片會依長寬比保持面積一致。建議單張 ≤ 1600px、≤ 500KB 以維持流暢。

核心概念參考 [edoardolunardi/infinite-canvas](https://github.com/edoardolunardi/infinite-canvas)（MIT），此為不依賴 React 的原生 Three.js 重寫版。
