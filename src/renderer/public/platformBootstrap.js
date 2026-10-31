;(function applyDesktopPlatform() {
  var platform = window.desktopPlatform
  if (platform === 'darwin' || platform === 'win32' || platform === 'linux') {
    document.documentElement.setAttribute('data-platform', platform)
  }
})()
