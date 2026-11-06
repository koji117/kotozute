// キーの画面（desktop/key.html）だけが使う。渡せるのは「保存するキー」か null（キーなしで使う）だけ。
// sandbox の画面の preload は CommonJS にする（ESM の preload は sandbox では使えない）
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kotozute', {
  setKey: (key) => ipcRenderer.invoke('key', key),
});
