// electron-builder afterPack hook. electron-builder writes the Windows exe's icon
// and version info with rcedit, which on Linux needs Wine; package.json turns that
// off (win.signAndEditExecutable: false) and this hook does it with resedit, which
// is plain JavaScript, so Windows builds run on Linux without Wine.
const fs = require('node:fs');
const path = require('node:path');

exports.default = async function winExeResources(context) {
  if (context.electronPlatformName !== 'win32') return;
  const { load } = require('resedit/cjs');
  const ResEdit = await load();
  const info = context.packager.appInfo;
  const exe = path.join(context.appOutDir, `${info.productFilename}.exe`);
  const icon = ResEdit.Data.IconFile.from(fs.readFileSync(path.join(__dirname, '..', 'src', 'assets', 'icon.ico')));

  const pe = ResEdit.NtExecutable.from(fs.readFileSync(exe));
  const res = ResEdit.NtExecutableResource.from(pe);

  // Replace Electron's icon group(s) with Pane's, keeping their ids so the exe's main icon changes.
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
  const ids = groups.length ? groups.map(g => [g.id, g.lang]) : [[1, 1033]];
  for (const [id, lang] of ids) {
    ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, id, lang, icon.icons.map(i => i.data));
  }

  // Version info shown in Explorer's properties and the Task Manager.
  const [vi] = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
  if (vi) {
    const [major, minor, patch] = info.version.split('.').map(n => parseInt(n, 10) || 0);
    vi.setFileVersion(major, minor, patch, 0, 1033);
    vi.setProductVersion(major, minor, patch, 0, 1033);
    vi.setStringValues({ lang: 1033, codepage: 1200 }, {
      ProductName: info.productName,
      FileDescription: info.productName,
      CompanyName: info.companyName || '',
      LegalCopyright: info.copyright || '',
      OriginalFilename: `${info.productFilename}.exe`,
      InternalName: info.productFilename,
      FileVersion: info.version,
      ProductVersion: info.version,
    });
    vi.outputToResourceEntries(res.entries);
  }

  res.outputResource(pe);
  fs.writeFileSync(exe, Buffer.from(pe.generate()));
};
