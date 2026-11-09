//! Build script.
//!
//! 1. Embeds every file in web/ into the exe (release builds serve these; debug builds read web/ from disk).
//! 2. On Windows, writes the exe's icon, version information and manifest. It builds the COFF resource object
//!    itself, so no resource compiler (rc.exe, windres) is needed with either the MSVC or the GNU toolchain.
use std::env;
use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};

fn main() {
    let root = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let out = PathBuf::from(env::var("OUT_DIR").unwrap());
    let version = fs::read_to_string(root.join("VERSION")).map(|v| v.trim().to_string()).unwrap_or_else(|_| "0.0.0".into());
    println!("cargo:rustc-env=MYTUBE_VERSION={version}");
    for p in ["VERSION", "web", "assets/mytube.ico"] {
        println!("cargo:rerun-if-changed={p}");
    }

    embed_web(&root.join("web"), &out.join("web_files.rs"));

    if env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        let obj = out.join("mytube-resources.o");
        match resources::write(&root.join("assets").join("mytube.ico"), &version, &obj) {
            Ok(()) => println!("cargo:rustc-link-arg-bins={}", obj.display()),
            Err(e) => println!("cargo:warning=exe resources skipped: {e}"),
        }
    }
}

/// `WEB_FILES: &[(&str, &[u8])]`, file names relative to web/ with forward slashes.
fn embed_web(dir: &Path, dest: &Path) {
    let mut files = Vec::new();
    collect(dir, dir, &mut files);
    files.sort();
    let mut code = String::from("pub static WEB_FILES: &[(&str, &[u8])] = &[\n");
    for (rel, abs) in files {
        writeln!(code, "    ({rel:?}, include_bytes!({abs:?})),").unwrap();
    }
    code.push_str("];\n");
    fs::write(dest, code).unwrap();
}

fn collect(base: &Path, dir: &Path, files: &mut Vec<(String, String)>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect(base, &path, files);
        } else {
            let rel = path.strip_prefix(base).unwrap().to_string_lossy().replace('\\', "/");
            files.push((rel, path.display().to_string()));
        }
    }
}

mod resources {
    use object::write::{Object, Relocation};
    use object::{Architecture, BinaryFormat, Endianness, RelocationEncoding, RelocationFlags, RelocationKind, SectionKind};
    use std::{env, fs, path::Path};

    const RT_ICON: u32 = 3;
    const RT_GROUP_ICON: u32 = 14;
    const RT_VERSION: u32 = 16;
    const RT_MANIFEST: u32 = 24;
    const LANG_EN_US: u32 = 0x0409;

    const MANIFEST: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <trustInfo xmlns="urn:schemas-microsoft-com:asm.v3">
    <security><requestedPrivileges><requestedExecutionLevel level="asInvoker" uiAccess="false"/></requestedPrivileges></security>
  </trustInfo>
  <compatibility xmlns="urn:schemas-microsoft-com:compatibility.v1">
    <application><supportedOS Id="{8e0f7a12-bfb3-4fe8-b9a5-48fd50a15a9a}"/></application>
  </compatibility>
  <application xmlns="urn:schemas-microsoft-com:asm.v3">
    <windowsSettings>
      <dpiAware xmlns="http://schemas.microsoft.com/SMI/2005/WindowsSettings">true/pm</dpiAware>
      <dpiAwareness xmlns="http://schemas.microsoft.com/SMI/2016/WindowsSettings">PerMonitorV2</dpiAwareness>
      <longPathAware xmlns="http://schemas.microsoft.com/SMI/2016/WindowsSettings">true</longPathAware>
    </windowsSettings>
  </application>
  <dependency><dependentAssembly>
    <assemblyIdentity type="win32" name="Microsoft.Windows.Common-Controls" version="6.0.0.0" processorArchitecture="*" publicKeyToken="6595b64144ccf1df" language="*"/>
  </dependentAssembly></dependency>
</assembly>
"#;

    struct Res {
        typ: u32,
        id: u32,
        data: Vec<u8>,
    }

    pub fn write(ico: &Path, version: &str, dest: &Path) -> Result<(), String> {
        let arch = match env::var("CARGO_CFG_TARGET_ARCH").as_deref() {
            Ok("x86_64") => Architecture::X86_64,
            Ok("aarch64") => Architecture::Aarch64,
            Ok("x86") => Architecture::I386,
            other => return Err(format!("unsupported architecture {other:?}")),
        };
        let mut list = icon_resources(&fs::read(ico).map_err(|e| format!("{}: {e}", ico.display()))?)?;
        list.push(Res { typ: RT_VERSION, id: 1, data: version_info(version) });
        list.push(Res { typ: RT_MANIFEST, id: 1, data: MANIFEST.as_bytes().to_vec() });
        list.sort_by_key(|r| (r.typ, r.id));
        let (data, leaf_offsets) = resource_tree(&list);

        let mut obj = Object::new(BinaryFormat::Coff, arch, Endianness::Little);
        let section = obj.add_section(Vec::new(), b".rsrc".to_vec(), SectionKind::ReadOnlyData);
        obj.append_section_data(section, &data, 8);
        let symbol = obj.section_symbol(section);
        // Each data entry holds the RVA of its bytes, which only the linker knows: an image-relative relocation.
        for (field, target) in leaf_offsets {
            let flags = RelocationFlags::Generic { kind: RelocationKind::ImageOffset, encoding: RelocationEncoding::Generic, size: 32 };
            obj.add_relocation(section, Relocation { offset: field as u64, symbol, addend: target as i64, flags })
                .map_err(|e| e.to_string())?;
        }
        fs::write(dest, obj.write().map_err(|e| e.to_string())?).map_err(|e| e.to_string())
    }

    fn u16le(b: &[u8], at: usize) -> u16 {
        u16::from_le_bytes([b[at], b[at + 1]])
    }

    fn u32le(b: &[u8], at: usize) -> u32 {
        u32::from_le_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]])
    }

    /// An .ico file becomes one RT_ICON per image plus the RT_GROUP_ICON that lists them.
    fn icon_resources(ico: &[u8]) -> Result<Vec<Res>, String> {
        if ico.len() < 6 || u16le(ico, 2) != 1 {
            return Err("not an .ico file".into());
        }
        let count = u16le(ico, 4) as usize;
        let mut group = ico[..6].to_vec();
        let mut out = Vec::new();
        for i in 0..count {
            let e = 6 + i * 16;
            let entry = ico.get(e..e + 16).ok_or("truncated .ico")?;
            let (size, offset) = (u32le(entry, 8) as usize, u32le(entry, 12) as usize);
            let image = ico.get(offset..offset + size).ok_or("truncated .ico image")?;
            let id = i as u32 + 1;
            group.extend_from_slice(&entry[..12]);
            group.extend_from_slice(&(id as u16).to_le_bytes());
            out.push(Res { typ: RT_ICON, id, data: image.to_vec() });
        }
        out.push(Res { typ: RT_GROUP_ICON, id: 1, data: group });
        Ok(out)
    }

    /// Three directory levels (type, id, language) followed by the data entries and the data.
    /// Returns the section bytes and, for each data entry, (offset of its RVA field, offset of its data).
    fn resource_tree(list: &[Res]) -> (Vec<u8>, Vec<(usize, usize)>) {
        let mut types: Vec<u32> = list.iter().map(|r| r.typ).collect();
        types.dedup();
        let dir_size = |n: usize| 16 + 8 * n;
        // layout: root dir, one dir per type, one language dir per resource, data entries, data
        let mut pos = dir_size(types.len());
        let mut type_dir_at = Vec::new();
        for t in &types {
            type_dir_at.push(pos);
            pos += dir_size(list.iter().filter(|r| r.typ == *t).count());
        }
        let lang_dir_at: Vec<usize> = (0..list.len()).map(|i| pos + i * dir_size(1)).collect();
        pos += list.len() * dir_size(1);
        let entry_at: Vec<usize> = (0..list.len()).map(|i| pos + i * 16).collect();
        pos += list.len() * 16;
        let mut data_at = Vec::new();
        for r in list {
            pos = pos.next_multiple_of(8);
            data_at.push(pos);
            pos += r.data.len();
        }

        let mut b = Vec::with_capacity(pos);
        let dir = |b: &mut Vec<u8>, n: usize| {
            b.extend_from_slice(&[0; 12]);
            b.extend_from_slice(&0u16.to_le_bytes());
            b.extend_from_slice(&(n as u16).to_le_bytes());
        };
        let entry = |b: &mut Vec<u8>, id: u32, offset: usize, subdir: bool| {
            b.extend_from_slice(&id.to_le_bytes());
            b.extend_from_slice(&(offset as u32 | if subdir { 0x8000_0000 } else { 0 }).to_le_bytes());
        };
        dir(&mut b, types.len());
        for (t, at) in types.iter().zip(&type_dir_at) {
            entry(&mut b, *t, *at, true);
        }
        for t in &types {
            let members: Vec<usize> = (0..list.len()).filter(|&i| list[i].typ == *t).collect();
            dir(&mut b, members.len());
            for i in members {
                entry(&mut b, list[i].id, lang_dir_at[i], true);
            }
        }
        for i in 0..list.len() {
            dir(&mut b, 1);
            entry(&mut b, LANG_EN_US, entry_at[i], false);
        }
        let mut relocs = Vec::new();
        for (i, r) in list.iter().enumerate() {
            relocs.push((b.len(), data_at[i]));
            b.extend_from_slice(&(data_at[i] as u32).to_le_bytes()); // replaced by the relocation
            b.extend_from_slice(&(r.data.len() as u32).to_le_bytes());
            b.extend_from_slice(&[0; 8]); // code page, reserved
        }
        for (i, r) in list.iter().enumerate() {
            b.resize(data_at[i], 0);
            b.extend_from_slice(&r.data);
        }
        (b, relocs)
    }

    fn utf16z(s: &str) -> Vec<u8> {
        s.encode_utf16().chain([0]).flat_map(u16::to_le_bytes).collect()
    }

    fn pad4(b: &mut Vec<u8>) {
        b.resize(b.len().next_multiple_of(4), 0);
    }

    /// One node of VS_VERSIONINFO: header, key, value, children, each part 4-byte aligned.
    fn block(key: &str, text: bool, value: &[u8], value_len: usize, children: &[Vec<u8>]) -> Vec<u8> {
        let mut b = vec![0, 0];
        b.extend_from_slice(&(value_len as u16).to_le_bytes());
        b.extend_from_slice(&(text as u16).to_le_bytes());
        b.extend_from_slice(&utf16z(key));
        pad4(&mut b);
        b.extend_from_slice(value);
        for child in children {
            pad4(&mut b);
            b.extend_from_slice(child);
        }
        let len = b.len() as u16;
        b[..2].copy_from_slice(&len.to_le_bytes());
        b
    }

    fn version_info(version: &str) -> Vec<u8> {
        let mut n = version.split('.').map(|p| p.parse::<u16>().unwrap_or(0)).chain([0; 4]);
        let v: [u32; 4] = std::array::from_fn(|_| n.next().unwrap() as u32);
        let (ms, ls) = ((v[0] << 16) | v[1], (v[2] << 16) | v[3]);
        let fixed: Vec<u8> = [0xFEEF04BD, 0x0001_0000, ms, ls, ms, ls, 0x3f, 0, 0x0004_0004, 1, 0, 0, 0]
            .iter()
            .flat_map(|x: &u32| x.to_le_bytes())
            .collect();
        let strings: Vec<Vec<u8>> = [
            ("CompanyName", "mohameddddt"),
            ("FileDescription", "My Tube - personal YouTube interface"),
            ("FileVersion", version),
            ("InternalName", "MyTube"),
            ("LegalCopyright", "Personal project. Not affiliated with YouTube or Google."),
            ("OriginalFilename", "MyTube.exe"),
            ("ProductName", "My Tube"),
            ("ProductVersion", version),
        ]
        .iter()
        .map(|(k, v)| block(k, true, &utf16z(v), v.encode_utf16().count() + 1, &[]))
        .collect();
        let table = block("040904B0", true, &[], 0, &strings);
        let string_info = block("StringFileInfo", true, &[], 0, &[table]);
        let translation = [0x0409u16.to_le_bytes(), 1200u16.to_le_bytes()].concat();
        let var_info = block("VarFileInfo", true, &[], 0, &[block("Translation", false, &translation, 4, &[])]);
        block("VS_VERSION_INFO", false, &fixed, fixed.len(), &[string_info, var_info])
    }
}
