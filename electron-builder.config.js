// electron-builder configuration — Windows targets (NSIS installer + portable exe).
// Structured so electron-updater can be wired up later via the `publish` block.
module.exports = {
  appId: "ai.mistral.desktop",
  productName: "Mist Desktop",
  copyright: "Copyright © 2026 Mist Desktop",
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
    icon: "build/icon.ico",
    target: [
      { target: "nsis", arch: ["x64"] },
      { target: "portable", arch: ["x64"] }
    ],
    artifactName: "${productName}-${version}-${arch}.${ext}"
  },
  linux: {
    icon: "build/icon.png",
    target: [
      { target: "AppImage", arch: ["x64"] },
      { target: "pacman", arch: ["x64"] },
      { target: "deb", arch: ["x64"] }
    ],
    maintainer: "thonny_dev <thonnydev@gmail.com>",
    // homepage: "https://github.com/Thonny-Developer/mist-desktop",
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
    shortcutName: "Mist Desktop"
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
