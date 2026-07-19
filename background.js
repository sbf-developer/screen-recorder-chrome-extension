chrome.runtime.onInstalled.addListener(() => {
  console.log('Screen Recorder installed');
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'DOWNLOAD') {
    chrome.downloads.download(
      { url: message.url, filename: message.filename, saveAs: false },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          sendResponse({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          sendResponse({ ok: true, downloadId });
        }
      }
    );
    return true;
  }
});
