// electron-builder configuration — Windows targets (NSIS installer + portable exe).
// Structured so electron-updater can be wired up later via the `publish` block.
module.exports = {
  appId: "ai.mistral.cli",
  productName: "Mistral CLI",
  copyright: "Copyright © 2026 Mistral CLI",
  // Ship only what the runtime needs.
  files: [
    "src/**/*",
    "package.json",
    "!**/*.map"
  ],
  directories: {
    output: "dist",
    buildResources: "build"
  },
  win: {
    target: [
      { target: "nsis", arch: ["x64"] },
      { target: "portable", arch: ["x64"] }
    ],
    // Drop a 256x256 (or larger) `build/icon.ico` to brand the app.
    // If absent, electron-builder falls back to the default Electron icon,
    // so packaging still works out of the box.
    artifactName: "${productName}-${version}-${arch}.${ext}"
  },
  linux: {
    target: [
      { target: "AppImage", arch: ["x64"] },
      { target: "pacman", arch: ["x64"] },
      { target: "deb", arch: ["x64"] }
    ],
    // Author shown in deb/pacman package metadata (Maintainer field).
    maintainer: "thonny_dev <thonnydev@gmail.com>",
    // Project page linked from the package metadata (Homepage field).
    homepage: "https://github.com/Thonny-Developer/mist-desktop",
    // Drop a 512x512 `build/icon.png` to brand the app; falls back to the
    // default Electron icon otherwise.
    category: "Utility",
    artifactName: "${productName}-${version}-${arch}.${ext}"
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    deleteAppDataOnUninstall: false,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: "Mistral CLI"
  },
  portable: {
    artifactName: "${productName}-${version}-portable.${ext}"
  },
  // Auto-updater target. Stubbed here — fill in a real provider when publishing.
  publish: [
    {
      provider: "generic",
      url: "https://example.com/mistral-cli/updates/"
    }
  ]
};
