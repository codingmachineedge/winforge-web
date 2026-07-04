import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { runCommand, runPowershellJson } from '../tauri/bridge';
import { AsyncState, Column, DataTable, ModuleToolbar, StatusDot, useAsync } from './common';
import { ModuleTabs } from './ModuleTabs';

// ---------------------------------------------------------------------------
// Native port of WinForge's Archives module (module.archives).
// Wraps the 7-Zip CLI (7z.exe) for create / extract / list / test plus the full
// catalog of 100+ advanced operations, driven against a user-selected archive +
// source path. Bilingual strings mirror the WinForge C# P("en","粵語") originals.
//
// This is the UPGRADED surface: it now also covers the C# ops that were missing
// (named-entry / wildcard-subset / -snc extract, encrypted-header & keep-time
// create, convert-to-7z, header-enc / multithread / big-dict add, test-volumes,
// make-sfx, tar step-1, password-strength, all four -mx levels), plus two things
// the C# page implied but never surfaced as a control: a real parsed Contents
// table (l -slt → per-entry rows with an Extract-this row action) and an
// overwrite-policy selector for extraction. {entry} and {pattern} placeholders
// are fed from dedicated fields so those ops actually run instead of no-op'ing.
// ---------------------------------------------------------------------------

interface Engine {
  Installed: boolean;
  Exe: string;
  Version: string;
}

// One advanced operation. `args` uses {archive} {src} {outdir} {password} {entry}
// {pattern} placeholders that are substituted at run time — identical to
// ArchiveService, with {entry}/{pattern} fed from the extra Selection fields.
interface Op {
  id: string;
  enTitle: string;
  zhTitle: string;
  enDesc: string;
  zhDesc: string;
  enBtn: string;
  zhBtn: string;
  args: string;
  needsArchive: boolean;
  needsSource: boolean;
  destructive: boolean;
  keywords: string;
  rar?: boolean;
  needsEntry?: boolean;
  needsPattern?: boolean;
}

function op(
  id: string,
  enTitle: string,
  zhTitle: string,
  enDesc: string,
  zhDesc: string,
  enBtn: string,
  zhBtn: string,
  args: string,
  o: {
    needsArchive?: boolean;
    needsSource?: boolean;
    destructive?: boolean;
    rar?: boolean;
    needsEntry?: boolean;
    needsPattern?: boolean;
    keywords: string;
  },
): Op {
  return {
    id,
    enTitle,
    zhTitle,
    enDesc,
    zhDesc,
    enBtn,
    zhBtn,
    args,
    needsArchive: o.needsArchive ?? true,
    needsSource: o.needsSource ?? false,
    destructive: o.destructive ?? false,
    rar: o.rar,
    needsEntry: o.needsEntry,
    needsPattern: o.needsPattern,
    keywords: o.keywords,
  };
}

// Full catalog ported 1:1 from Catalog/ArchiveOperations.cs (100 7-Zip ops + 2 RAR).
const OPERATIONS: Op[] = [
  // ===== inspect (20) =====
  op('arc.inspect.list', 'List contents', '列出內容', 'List the files and folders inside the selected archive.', '列出揀咗嗰個壓縮檔入面嘅檔案同資料夾。', 'List', '列出', 'l {archive}', { keywords: 'list contents 列出 內容' }),
  op('arc.inspect.list-technical', 'List (technical)', '列出（技術詳情）', 'Show full technical details for every entry using -slt.', '用 -slt 列出每個項目嘅完整技術詳情。', 'List', '列出', 'l -slt {archive}', { keywords: 'list technical slt 詳情 技術' }),
  op('arc.inspect.list-crc', 'List with CRC', '列出（連 CRC）', 'List entries with technical details, which include CRC checksums.', '用技術詳情列出項目，入面包含 CRC 校驗碼。', 'List', '列出', 'l -slt {archive}', { keywords: 'list crc checksum 校驗' }),
  op('arc.inspect.test', 'Test integrity', '測試完整性', 'Test the archive to verify nothing is corrupted.', '測試壓縮檔，睇下有冇損壞。', 'Test', '測試', 't {archive}', { keywords: 'test integrity verify 完整 測試' }),
  op('arc.inspect.test-password', 'Test (with password)', '測試（連密碼）', 'Test an encrypted archive using the password field above.', '用上面密碼欄嘅密碼測試一個加密咗嘅壓縮檔。', 'Test', '測試', 't -p{password} {archive}', { keywords: 'test password encrypted 密碼 加密' }),
  op('arc.inspect.show-type', 'Show archive type', '顯示壓縮檔類型', 'Display the archive format and type information via technical listing.', '用技術詳情顯示壓縮檔嘅格式同類型資料。', 'Show', '顯示', 'l -slt {archive}', { keywords: 'type format info 類型 格式' }),
  op('arc.inspect.count', 'Count entries', '點算項目數量', 'List entries so you can see how many files the archive holds.', '列出項目，睇下個壓縮檔有幾多個檔案。', 'Count', '點算', 'l {archive}', { keywords: 'count entries number 數量 項目' }),
  op('arc.inspect.list-folders', 'List folders only', '淨係列出資料夾', 'List only directory entries by excluding files with a recursive pattern.', '用遞迴模式排除檔案，淨係列出資料夾項目。', 'List', '列出', 'l {archive} -x!*.*', { keywords: 'folders directories 資料夾 目錄' }),
  op('arc.inspect.list-sorted', 'List sorted (technical)', '排序列出（技術詳情）', 'List entries with full technical details so they can be sorted by field.', '用完整技術詳情列出項目，方便按欄位排序。', 'List', '列出', 'l -slt {archive}', { keywords: 'list sorted 排序 列出' }),
  op('arc.inspect.list-fullpaths', 'List full paths', '列出完整路徑', 'List every entry using fully qualified file paths.', '用完整檔案路徑列出每個項目。', 'List', '列出', 'l -spf {archive}', { keywords: 'list fullpath paths 路徑 完整' }),
  op('arc.inspect.hash-source', 'Hash source', '計來源雜湊', 'Compute checksums of the selected source file or folder.', '計揀咗嘅來源檔案或者資料夾嘅校驗雜湊。', 'Hash', '計雜湊', 'h {src}', { needsArchive: false, needsSource: true, keywords: 'hash checksum source 雜湊 來源' }),
  op('arc.inspect.hash-sha256', 'Hash source (SHA-256)', '計來源雜湊（SHA-256）', 'Compute SHA-256 checksums of the selected source.', '用 SHA-256 計揀咗嘅來源嘅校驗雜湊。', 'Hash', '計雜湊', 'h -scrcSHA256 {src}', { needsArchive: false, needsSource: true, keywords: 'hash sha256 checksum 雜湊' }),
  op('arc.inspect.hash-sha1', 'Hash source (SHA-1)', '計來源雜湊（SHA-1）', 'Compute SHA-1 checksums of the selected source.', '用 SHA-1 計揀咗嘅來源嘅校驗雜湊。', 'Hash', '計雜湊', 'h -scrcSHA1 {src}', { needsArchive: false, needsSource: true, keywords: 'hash sha1 checksum 雜湊' }),
  op('arc.inspect.hash-all', 'Hash source (all)', '計來源雜湊（全部）', 'Compute every supported checksum type for the selected source.', '計揀咗嘅來源所有支援嘅校驗雜湊類型。', 'Hash', '計雜湊', 'h -scrc* {src}', { needsArchive: false, needsSource: true, keywords: 'hash all checksum 雜湊 全部' }),
  op('arc.inspect.crc-entries', 'CRC of entries', '項目嘅 CRC', 'List archive entries with technical details showing their CRC values.', '用技術詳情列出壓縮檔項目，顯示佢哋嘅 CRC 數值。', 'Show', '顯示', 'l -slt {archive}', { keywords: 'crc checksum entries 校驗 項目' }),
  op('arc.inspect.show-header', 'Show header info', '顯示標頭資料', 'Show archive header and metadata via a technical listing.', '用技術詳情顯示壓縮檔嘅標頭同中繼資料。', 'Show', '顯示', 'l -slt {archive}', { keywords: 'header metadata 標頭 中繼' }),
  op('arc.inspect.list-largest', 'List with sizes', '列出（連大細）', 'List entries with sizes so you can spot the largest files.', '連住大細列出項目，方便睇邊個檔案最大。', 'List', '列出', 'l -slt {archive}', { keywords: 'largest size big 最大 大細' }),
  op('arc.inspect.verify-multivolume', 'Verify multivolume', '驗證分卷壓縮檔', 'Test the first volume of a multivolume set for completeness and integrity.', '測試分卷壓縮檔嘅第一卷，睇下完整性同有冇齊。', 'Verify', '驗證', 't {archive}', { keywords: 'multivolume split volume 分卷 驗證' }),
  op('arc.inspect.show-method', 'Show method used', '顯示所用方法', 'Show the compression method used for each entry via -slt.', '用 -slt 顯示每個項目所用嘅壓縮方法。', 'Show', '顯示', 'l -slt {archive}', { keywords: 'method compression slt 方法 壓縮' }),
  op('arc.inspect.list-dates', 'List dates', '列出日期', 'List entries with their modification dates and times via -slt.', '用 -slt 連住修改日期同時間一齊列出項目。', 'List', '列出', 'l -slt {archive}', { keywords: 'dates time modified 日期 時間' }),

  // ===== extract (20) =====
  op('arc.extract-full', 'Extract (keep folders)', '解壓（保留資料夾）', 'Extract with full paths into a sibling _extracted folder.', '連住資料夾結構解壓到旁邊嘅 _extracted 資料夾。', 'Extract', '解壓', 'x {archive} -o{outdir} -y', { keywords: 'extract unzip fullpath 解壓 保留' }),
  op('arc.extract-flat', 'Extract (flatten, no folders)', '解壓（攤平，唔要資料夾）', 'Extract every file into one folder, ignoring stored paths.', '將所有檔案解壓到同一個資料夾，唔理入面嘅資料夾結構。', 'Extract', '解壓', 'e {archive} -o{outdir} -y', { keywords: 'extract flat nopath 攤平 解壓' }),
  op('arc.extract-overwrite-all', 'Extract (overwrite all)', '解壓（全部覆寫）', 'Extract and overwrite every existing file without asking.', '解壓嗰陣將所有已經存在嘅檔案直接覆寫，唔問你。', 'Extract', '解壓', 'x {archive} -o{outdir} -aoa -y', { destructive: true, keywords: 'extract overwrite aoa 覆寫 解壓' }),
  op('arc.extract-skip-existing', 'Extract (skip existing)', '解壓（跳過已有）', 'Extract but keep any file that already exists on disk.', '解壓嗰陣保留已經喺度嘅檔案，唔覆寫佢哋。', 'Extract', '解壓', 'x {archive} -o{outdir} -aos -y', { keywords: 'extract skip aos 跳過 解壓' }),
  op('arc.extract-auto-rename', 'Extract (auto-rename)', '解壓（自動改名）', 'Extract and auto-rename clashing files instead of overwriting.', '解壓嗰陣遇到撞名就自動改名，唔覆寫原本嘅檔案。', 'Extract', '解壓', 'x {archive} -o{outdir} -aou -y', { keywords: 'extract rename aou 改名 解壓' }),
  op('arc.extract-only-newer', 'Extract (only newer)', '解壓（只係較新）', 'Extract only entries newer than the file already on disk.', '淨係解壓比硬碟上面嗰個更新嘅檔案出嚟。', 'Extract', '解壓', 'x {archive} -o{outdir} -aot -y', { keywords: 'extract newer aot 較新 解壓' }),
  op('arc.extract-password', 'Extract (password)', '解壓（有密碼）', 'Extract a password-protected archive using your password.', '用你嘅密碼解壓一個加咗密嘅壓縮檔。', 'Extract', '解壓', 'x {archive} -p{password} -o{outdir} -y', { keywords: 'extract password encrypted 密碼 解壓' }),
  op('arc.extract-only-txt', 'Extract only *.txt', '只解壓 *.txt', 'Extract just the .txt files from the archive.', '淨係將壓縮檔入面嘅 .txt 檔案解壓出嚟。', 'Extract', '解壓', 'x {archive} -o{outdir} -i!*.txt -y', { keywords: 'extract filter txt include 只解壓' }),
  op('arc.extract-exclude-log', 'Extract (exclude *.log)', '解壓（唔要 *.log）', 'Extract everything except .log files.', '解壓所有嘢，但係唔要 .log 檔案。', 'Extract', '解壓', 'x {archive} -o{outdir} -x!*.log -y', { keywords: 'extract exclude log 排除 解壓' }),
  op('arc.extract-named-entry', 'Extract one named entry', '解壓指定檔案', 'Extract a single named file or folder (Entry field) from the archive.', '淨係將壓縮檔入面指定名（項目欄）嘅檔案或者資料夾解壓出嚟。', 'Extract', '解壓', 'x {archive} -o{outdir} {entry} -y', { needsEntry: true, keywords: 'extract single entry named 指定 解壓' }),
  op('arc.extract-recurse-subdirs', 'Extract subfolders (recurse)', '解壓（遞迴入子資料夾）', 'Recurse into subfolders so wildcard matches reach nested entries.', '解壓嗰陣遞迴入埋下面嘅子資料夾，等萬用字元都搵到入面嘅檔案。', 'Extract', '解壓', 'x {archive} -o{outdir} -r -y', { keywords: 'extract recursive subdir 遞迴 解壓' }),
  op('arc.extract-keep-timestamps', 'Extract (keep timestamps)', '解壓（保留時間）', 'Extract while restoring stored last-modified file timestamps.', '解壓嗰陣保留檔案原本嘅修改時間。', 'Extract', '解壓', 'x {archive} -o{outdir} -y', { keywords: 'extract timestamps time 時間 解壓' }),
  op('arc.extract-stdout', 'Extract to stdout', '解壓去 stdout', 'Write the extracted bytes to standard output instead of a file.', '將解壓出嚟嘅內容寫去標準輸出，唔寫成檔案。', 'Extract', '解壓', 'x {archive} -so -y', { keywords: 'extract stdout so pipe 輸出 解壓' }),
  op('arc.extract-show-tech', 'Extract (verbose log)', '解壓（詳細記錄）', 'Extract with full paths and show a verbose per-file log.', '連住路徑解壓，順便顯示每個檔案嘅詳細記錄。', 'Extract', '解壓', 'x {archive} -o{outdir} -bb3 -y', { keywords: 'extract verbose log 詳細 解壓' }),
  op('arc.test-then-extract', 'Test, then extract', '先測試後解壓', 'Test archive integrity first, then extract with full paths if it passes.', '先測試壓縮檔完唔完整，無事先連路徑解壓。', 'Run', '執行', 't {archive} -y', { keywords: 'extract test verify 測試 解壓' }),
  op('arc.extract-wildcard-subset', 'Extract a wildcard subset', '解壓萬用字元子集', 'Extract only entries matching a wildcard pattern (Pattern field).', '淨係解壓符合萬用字元樣式（樣式欄）嘅檔案。', 'Extract', '解壓', 'x {archive} -o{outdir} {pattern} -y', { needsPattern: true, keywords: 'extract wildcard subset pattern 子集 解壓' }),
  op('arc.extract-empty-stream-prefix', 'Extract (use stream of-name files)', '解壓（用 stream 檔名）', 'Extract treating alternate data stream entries by their full stream path.', '解壓嗰陣用完整 stream 路徑嚟處理交替資料流嘅項目。', 'Extract', '解壓', 'x {archive} -o{outdir} -snc -y', { keywords: 'extract stream snc 資料流 解壓' }),
  op('arc.extract-flat-overwrite', 'Extract (flat, overwrite)', '解壓（攤平兼覆寫）', 'Flatten all files into one folder and overwrite any clashes.', '將所有檔案攤平到一個資料夾，撞名就覆寫。', 'Extract', '解壓', 'e {archive} -o{outdir} -aoa -y', { destructive: true, keywords: 'extract flat overwrite 攤平 覆寫 解壓' }),
  op('arc.extract-only-images', 'Extract images (*.jpg *.png)', '解壓圖片（*.jpg *.png）', 'Extract just the .jpg and .png image files.', '淨係將 .jpg 同 .png 圖片檔解壓出嚟。', 'Extract', '解壓', 'x {archive} -o{outdir} -i!*.jpg -i!*.png -y', { keywords: 'extract images jpg png 圖片 解壓' }),
  op('arc.extract-encrypted-headers', 'Extract (encrypted headers)', '解壓（加密檔頭）', "Extract an archive whose file-name headers are also encrypted, using your password.", '用你嘅密碼解壓一個連檔名檔頭都加咗密嘅壓縮檔。', 'Extract', '解壓', 'x {archive} -p{password} -o{outdir} -y', { keywords: 'extract encrypted header mhe 密碼 解壓' }),

  // ===== create (20) =====
  op('arc.create-7z-store', 'Create .7z (store)', '建立 .7z（唔壓縮）', 'Pack the source into a .7z with no compression (store only).', '將來源裝入 .7z，唔做壓縮，淨係儲存。', 'Create', '建立', 'a -t7z -mx=0 {archive} {src}', { needsSource: true, destructive: true, keywords: 'create 7z store 儲存 壓縮' }),
  op('arc.create-7z-fast', 'Create .7z (fast)', '建立 .7z（快速）', 'Compress the source into a .7z at the fast level.', '用快速等級將來源壓成 .7z。', 'Create', '建立', 'a -t7z -mx=1 {archive} {src}', { needsSource: true, destructive: true, keywords: 'create 7z fast 快速 壓縮' }),
  op('arc.create-7z-normal', 'Create .7z (normal)', '建立 .7z（正常）', 'Compress the source into a .7z at the normal level.', '用正常等級將來源壓成 .7z。', 'Create', '建立', 'a -t7z -mx=5 {archive} {src}', { needsSource: true, destructive: true, keywords: 'create 7z normal 正常 壓縮' }),
  op('arc.create-7z-ultra', 'Create .7z (ultra)', '建立 .7z（極致）', 'Compress the source into a .7z at the ultra level.', '用極致等級將來源壓成 .7z。', 'Create', '建立', 'a -t7z -mx=9 {archive} {src}', { needsSource: true, destructive: true, keywords: 'create 7z ultra 極致 壓縮' }),
  op('arc.create-zip', 'Create .zip', '建立 .zip', 'Pack the selected source into a standard .zip archive.', '將揀咗嘅來源壓成標準 .zip 壓縮檔。', 'Create', '建立', 'a -tzip {archive} {src}', { needsSource: true, destructive: true, keywords: 'create zip 壓縮' }),
  op('arc.create-tar', 'Create .tar', '建立 .tar', 'Bundle the source into an uncompressed .tar archive.', '將來源打包成冇壓縮嘅 .tar 檔。', 'Create', '建立', 'a -ttar {archive} {src}', { needsSource: true, destructive: true, keywords: 'create tar 打包' }),
  op('arc.create-gz', 'Create .gz (gzip)', '建立 .gz（gzip）', 'Compress a single file into a .gz using gzip.', '用 gzip 將單一檔案壓成 .gz。', 'Create', '建立', 'a -tgzip {archive} {src}', { needsSource: true, destructive: true, keywords: 'create gz gzip 壓縮' }),
  op('arc.create-bz2', 'Create .bz2 (bzip2)', '建立 .bz2（bzip2）', 'Compress a single file into a .bz2 using bzip2.', '用 bzip2 將單一檔案壓成 .bz2。', 'Create', '建立', 'a -tbzip2 {archive} {src}', { needsSource: true, destructive: true, keywords: 'create bz2 bzip2 壓縮' }),
  op('arc.create-xz', 'Create .xz', '建立 .xz', 'Compress a single file into a .xz archive.', '將單一檔案壓成 .xz 壓縮檔。', 'Create', '建立', 'a -txz {archive} {src}', { needsSource: true, destructive: true, keywords: 'create xz 壓縮' }),
  op('arc.create-wim', 'Create .wim', '建立 .wim', 'Pack the source into a Windows Imaging .wim archive.', '將來源打包成 Windows 映像 .wim 檔。', 'Create', '建立', 'a -twim {archive} {src}', { needsSource: true, destructive: true, keywords: 'create wim 映像 image' }),
  op('arc.create-7z-encrypted', 'Create encrypted .7z (hide names)', '建立加密 .7z（隱藏檔名）', 'Make a password-protected .7z with an encrypted header so file names are hidden.', '整個有密碼嘅 .7z，連檔頭都加密，連檔名都收埋。', 'Create', '建立', 'a -t7z -p{password} -mhe=on {archive} {src}', { needsSource: true, destructive: true, keywords: 'create 7z password encrypt 加密 密碼' }),
  op('arc.create-7z-solid', 'Create .7z (solid block)', '建立 .7z（實體區塊）', 'Compress with solid archiving on for a smaller .7z.', '開實體壓縮，將啲檔當成一嚿，整個更細嘅 .7z。', 'Create', '建立', 'a -t7z -ms=on {archive} {src}', { needsSource: true, destructive: true, keywords: 'create 7z solid 實體 壓縮' }),
  op('arc.create-7z-mt', 'Create .7z (multithread)', '建立 .7z（多執行緒）', 'Compress into .7z using all CPU threads for speed.', '用齊 CPU 多執行緒嚟加快將來源壓成 .7z。', 'Create', '建立', 'a -t7z -mmt=on {archive} {src}', { needsSource: true, destructive: true, keywords: 'create 7z multithread mt 多執行緒 壓縮' }),
  op('arc.create-7z-sfx', 'Create self-extracting .7z', '建立自解壓 .7z', 'Build a self-extracting .exe from the source files.', '用來源整個自己識解壓嘅 .exe。', 'Create', '建立', 'a -t7z -sfx {archive} {src}', { needsSource: true, destructive: true, keywords: 'create 7z sfx self-extract 自解壓' }),
  op('arc.create-7z-split-100m', 'Create split .7z (100m volumes)', '建立分割 .7z（每卷 100m）', 'Compress and split the archive into 100 MB volumes.', '壓縮嘅同時將檔分割成每卷 100 MB。', 'Create', '建立', 'a -t7z -v100m {archive} {src}', { needsSource: true, destructive: true, keywords: 'create 7z split volume 分割 壓縮' }),
  op('arc.create-7z-split-25m', 'Create split .7z (25m email)', '建立分割 .7z（25m 電郵）', 'Split into 25 MB volumes that fit common email limits.', '分割成每卷 25 MB，啱啱好過到一般電郵上限。', 'Create', '建立', 'a -t7z -v25m {archive} {src}', { needsSource: true, destructive: true, keywords: 'create 7z split email volume 電郵 分割' }),
  op('arc.create-7z-dict-64m', 'Create .7z (64m dictionary)', '建立 .7z（64m 字典）', 'Compress with a 64 MB dictionary for a better ratio.', '用 64 MB 字典壓縮，壓縮率更好。', 'Create', '建立', 'a -t7z -md=64m {archive} {src}', { needsSource: true, destructive: true, keywords: 'create 7z dictionary md 字典 壓縮' }),
  op('arc.create-7z-lzma2', 'Create .7z (LZMA2 method)', '建立 .7z（LZMA2 方法）', 'Compress the source into .7z using the LZMA2 method.', '用 LZMA2 方法將來源壓成 .7z。', 'Create', '建立', 'a -t7z -m0=LZMA2 {archive} {src}', { needsSource: true, destructive: true, keywords: 'create 7z lzma2 method 方法 壓縮' }),
  op('arc.create-7z-keep-time', 'Create .7z (keep timestamps)', '建立 .7z（保留時間戳）', 'Compress into .7z while preserving creation timestamps.', '壓成 .7z 嘅同時保留建立時間戳。', 'Create', '建立', 'a -t7z -mtc=on {archive} {src}', { needsSource: true, destructive: true, keywords: 'create 7z timestamp time 時間戳 壓縮' }),
  op('arc.create-7z-max-combo', 'Create .7z (max-compression combo)', '建立 .7z（最強壓縮組合）', 'Ultra level, solid, 64 MB dictionary and big word size for the smallest .7z.', '極致等級、實體、64 MB 字典加大字長，整個最細嘅 .7z。', 'Create', '建立', 'a -t7z -mx=9 -ms=on -md=64m -mfb=273 {archive} {src}', { needsSource: true, destructive: true, keywords: 'create 7z max ultra solid 最強 壓縮' }),

  // ===== modify (20) =====
  op('arc.mod-add', 'Add files', '加入檔案', 'Add the selected source into the existing archive.', '將揀咗嘅來源加入現有嘅壓縮檔。', 'Add', '加入', 'a {archive} {src}', { needsSource: true, destructive: true, keywords: 'add append 加入 壓縮' }),
  op('arc.mod-update', 'Update changed files', '更新有改動嘅檔案', 'Update the archive with newer or changed source files.', '用較新或者有改動嘅來源更新壓縮檔。', 'Update', '更新', 'u {archive} {src}', { needsSource: true, destructive: true, keywords: 'update changed 更新 改動' }),
  op('arc.mod-fresh', 'Refresh existing only', '只更新已有檔案', 'Refresh only files already in the archive, never adding new ones.', '淨係更新壓縮檔入面已經有嘅檔案，唔會加新嘅。', 'Refresh', '更新', 'u {archive} {src} -up0q3r2x2y2z0w2', { needsSource: true, destructive: true, keywords: 'refresh fresh existing 更新 已有' }),
  op('arc.mod-delete', 'Delete entry', '刪除項目', 'Delete the matching entries (Entry field, e.g. *.tmp) from inside the archive.', '將壓縮檔入面符合（項目欄，例如 *.tmp）嘅項目刪除咗佢。', 'Delete', '刪除', 'd {archive} {entry}', { destructive: true, needsEntry: true, keywords: 'delete remove 刪除 項目' }),
  op('arc.mod-rename', 'Rename entry', '重新命名項目', 'Rename an entry inside the archive from the old name to a new name.', '將壓縮檔入面嘅項目由舊名改做新名。', 'Rename', '改名', 'rn {archive} old.txt new.txt', { destructive: true, keywords: 'rename rn 改名 項目' }),
  op('arc.mod-sync', 'Sync / mirror to source', '同步／鏡像到來源', 'Sync the archive to match the source, dropping entries no longer present.', '將壓縮檔同步到同來源一樣，唔再喺度嘅項目會被刪走。', 'Sync', '同步', 'u {archive} {src} -up3r2x2y2z0w2', { needsSource: true, destructive: true, keywords: 'sync mirror 同步 鏡像' }),
  op('arc.mod-add-exclude', 'Add but exclude pattern', '加入但排除樣式', 'Add the source while excluding files matching a pattern.', '加入來源嘅時候排除符合樣式嘅檔案。', 'Add', '加入', 'a {archive} {src} -x!*.log', { needsSource: true, destructive: true, keywords: 'add exclude 排除 加入' }),
  op('arc.mod-add-include', 'Add only matching', '只加入符合嘅', 'Add only files matching the include pattern from the source.', '淨係將來源入面符合樣式嘅檔案加入。', 'Add', '加入', 'a {archive} {src} -i!*.txt', { needsSource: true, destructive: true, keywords: 'add include 符合 加入' }),
  op('arc.mod-add-maxcomp', 'Add with max compression', '加入並用最大壓縮', 'Add the source overriding compression to the maximum level.', '加入來源嘅時候將壓縮等級設到最高。', 'Add', '加入', 'a {archive} {src} -mx=9', { needsSource: true, destructive: true, keywords: 'add max compression 加入 壓縮' }),
  op('arc.mod-add-solid', 'Add with solid blocks', '加入並用實心區塊', 'Add the source into a 7z using solid blocks for a better ratio.', '用實心區塊將來源加入 7z，壓縮比例好啲。', 'Add', '加入', 'a -t7z {archive} {src} -ms=on', { needsSource: true, destructive: true, keywords: 'add solid ms 實心 加入' }),
  op('arc.mod-recompress-7z', 'Recompress to .7z', '重新壓成 .7z', 'Add the source into the archive as a 7z stream at high compression.', '用高壓縮將來源加入成 7z 格式。', 'Recompress', '重壓', 'a -t7z {archive} {src} -mx=7', { needsSource: true, destructive: true, keywords: 'recompress 7z 重壓 壓縮' }),
  op('arc.mod-convert-7z', 'Convert to .7z (note)', '轉做 .7z（備註）', 'Build a .7z from the source; extract the old archive first if converting.', '由來源建立 .7z；若要轉換請先解壓舊檔。', 'Convert', '轉換', 'a -t7z {archive} {src}', { needsSource: true, destructive: true, keywords: 'convert zip 7z 轉換 壓縮' }),
  op('arc.mod-add-noroot', 'Add without root folder', '加入但去掉根資料夾', 'Add the source eliminating the duplicated root folder path.', '加入來源並去掉重複嘅根資料夾路徑。', 'Add', '加入', 'a {archive} {src} -spe', { needsSource: true, destructive: true, keywords: 'add spe root 路徑 加入' }),
  op('arc.mod-add-folder', 'Add single folder', '加入單一資料夾', 'Add a single source folder and everything inside it recursively.', '將單一個來源資料夾連入面所有嘢遞迴加入。', 'Add', '加入', 'a -r {archive} {src}', { needsSource: true, destructive: true, keywords: 'add folder recurse 資料夾 加入' }),
  op('arc.mod-append-store', 'Append without recompress', '唔重壓直接附加', 'Append the source stored uncompressed for speed.', '用儲存模式唔壓縮咁附加來源，求快。', 'Append', '附加', 'a {archive} {src} -mx=0', { needsSource: true, destructive: true, keywords: 'append store 附加 儲存' }),
  op('arc.mod-add-headerenc', 'Add with header encryption', '加入並加密標頭', 'Add the source with a password and encrypted file names.', '用密碼加入來源並加密埋檔名標頭。', 'Add', '加入', 'a {archive} {src} -p{password} -mhe=on', { needsSource: true, destructive: true, keywords: 'add encrypt header password 加密 加入' }),
  op('arc.mod-add-ppmd', 'Add with PPMd method', '加入並用 PPMd', 'Add the source using the PPMd method, good for text.', '用 PPMd 方法加入來源，啱用嚟壓文字。', 'Add', '加入', 'a -t7z {archive} {src} -m0=PPMd', { needsSource: true, destructive: true, keywords: 'add ppmd method 文字 加入' }),
  op('arc.mod-add-fullpath', 'Add with full path', '加入並用完整路徑', 'Add the source recording its full path inside the archive.', '加入來源並喺壓縮檔入面記低完整路徑。', 'Add', '加入', 'a {archive} {src} -spf', { needsSource: true, destructive: true, keywords: 'add fullpath spf 完整 路徑 加入' }),
  op('arc.mod-add-multithread', 'Add multithreaded', '加入並多線程', 'Add the source using all CPU threads for faster packing.', '用齊所有 CPU 線程加入來源，壓得快啲。', 'Add', '加入', 'a {archive} {src} -mmt=on', { needsSource: true, destructive: true, keywords: 'add multithread mmt 線程 加入' }),
  op('arc.mod-add-bigdict', 'Add with large dictionary', '加入並用大字典', 'Add the source with a large LZMA2 dictionary for a better ratio.', '用大嘅 LZMA2 字典加入來源，壓縮比例好啲。', 'Add', '加入', 'a -t7z {archive} {src} -md=64m', { needsSource: true, destructive: true, keywords: 'add dictionary md 字典 加入' }),

  // ===== advanced (20) =====
  op('arc.benchmark', 'Benchmark', '效能測試', 'Run the 7-Zip CPU compression and decompression benchmark.', '行 7-Zip 嘅 CPU 壓縮同解壓效能測試。', 'Run', '執行', 'b', { needsArchive: false, keywords: 'benchmark cpu 效能 測試' }),
  op('arc.benchmark-dict', 'Benchmark (64 MB dictionary)', '效能測試（64 MB 字典）', 'Run the benchmark using a 64 MB dictionary to stress memory bandwidth.', '用 64 MB 字典行效能測試，逼爆記憶體頻寬。', 'Run', '執行', 'b -md=64m', { needsArchive: false, keywords: 'benchmark dictionary 字典 效能' }),
  op('arc.formats-info', 'Show supported formats', '顯示支援格式', 'List every format, method and switch this 7-Zip build supports.', '列晒呢個 7-Zip 版本支援嘅格式、方法同開關。', 'Show', '顯示', 'i', { needsArchive: false, keywords: 'formats info 支援 格式' }),
  op('arc.version', 'Show version', '顯示版本', 'Print the 7-Zip version banner and copyright with no command.', '唔落任何指令，淨係印 7-Zip 嘅版本同版權出嚟睇。', 'Show', '顯示', '', { needsArchive: false, keywords: 'version about 版本' }),
  op('arc.hash-all', 'Hash source (all algorithms)', '雜湊來源（全部演算法）', 'Compute every available checksum algorithm for the selected source.', '幫揀咗嘅來源計晒所有可用嘅雜湊演算法。', 'Hash', '計雜湊', 'h -scrc* {src}', { needsArchive: false, needsSource: true, keywords: 'hash crc checksum 雜湊 校驗' }),
  op('arc.sha256-source', 'SHA-256 of source', '來源 SHA-256', 'Compute the SHA-256 checksum of the selected source file or folder.', '計揀咗嘅來源檔案或資料夾嘅 SHA-256 校驗值。', 'Hash', '計雜湊', 'h -scrcSHA256 {src}', { needsArchive: false, needsSource: true, keywords: 'sha256 hash source 雜湊 來源' }),
  op('arc.test-volumes', 'Test all volumes', '測試所有分卷', 'Verify integrity across every part of a multi-volume archive set.', '驗證多分卷壓縮檔每一卷嘅完整性。', 'Test', '測試', 't {archive}', { keywords: 'test volumes multivolume 分卷 測試' }),
  op('arc.encrypt-header-recompress', 'Recompress with encrypted header', '重壓並加密檔頭', 'Rebuild the archive so filenames are hidden behind an encrypted header.', '重新壓縮，將檔名收喺加密檔頭後面睇唔到。', 'Recompress', '重壓', 'a -mhe=on -p{password} {archive} {src}', { needsSource: true, destructive: true, keywords: 'encrypt header password 加密 檔頭' }),
  op('arc.threads-4', 'Compress with 4 threads', '用 4 條執行緒壓縮', 'Create the archive limiting compression to four CPU threads.', '建立壓縮檔，限制只用四條 CPU 執行緒嚟壓。', 'Create', '建立', 'a -mmt=4 {archive} {src}', { needsSource: true, destructive: true, keywords: 'threads mmt cpu 執行緒 壓縮' }),
  op('arc.ultra-bigdict', 'Ultra + 256 MB dictionary', '極致 + 256 MB 字典', 'Compress at ultra level with a huge 256 MB dictionary for best ratio.', '用極致等級加 256 MB 大字典壓，搏最高壓縮率。', 'Create', '建立', 'a -t7z -mx=9 -md=256m {archive} {src}', { needsSource: true, destructive: true, keywords: 'ultra dictionary md 極致 字典' }),
  op('arc.make-sfx', 'Make SFX installer', '整 SFX 自解壓檔', 'Create a self-extracting executable archive using the 7z SFX module.', '用 7z SFX 模組整一個自己解得開嘅執行檔。', 'Create', '建立', 'a -sfx7z.sfx {archive} {src}', { needsSource: true, destructive: true, keywords: 'sfx selfextract installer 自解壓 安裝' }),
  op('arc.create-tar-step1', 'Create .tar (step 1 of tar.gz)', '建立 .tar（tar.gz 第一步）', 'First step of a tar.gz: pack the source into an uncompressed .tar.', '整 tar.gz 第一步：將來源打包成未壓縮嘅 .tar。', 'Create', '建立', 'a -ttar {archive} {src}', { needsSource: true, destructive: true, keywords: 'tar gzip twostep 打包 第一步' }),
  op('arc.list-slt', 'List (forensic detail)', '列出（鑑識細節）', 'Show full technical metadata for every entry using -slt.', '用 -slt 列出每個項目嘅完整技術中繼資料。', 'List', '列出', 'l {archive} -slt', { keywords: 'list slt forensic metadata 鑑識 細節' }),
  op('arc.password-strength', 'Set strong password', '設定強密碼', 'Encrypt the archive with the password field and hide file names.', '用密碼欄嘅密碼加密壓縮檔，連檔名都收埋。', 'Encrypt', '加密', 'a -p{password} -mhe=on {archive} {src}', { needsSource: true, destructive: true, keywords: 'password strength encrypt 密碼 加密' }),
  op('arc.level-fastest', 'Level: fastest (-mx=1)', '等級：最快（-mx=1）', 'Compress at the fastest level with minimal CPU effort.', '用最快等級壓，CPU 出最少力。', 'Create', '建立', 'a -mx=1 {archive} {src}', { needsSource: true, destructive: true, keywords: 'fastest level mx1 最快 等級' }),
  op('arc.level-fast', 'Level: fast (-mx=3)', '等級：快（-mx=3）', 'Compress at a fast level balancing speed over ratio.', '用快等級壓，速度行先壓縮率其次。', 'Create', '建立', 'a -mx=3 {archive} {src}', { needsSource: true, destructive: true, keywords: 'fast level mx3 快 等級' }),
  op('arc.level-normal', 'Level: normal (-mx=5)', '等級：正常（-mx=5）', 'Compress at the default normal level for a balanced result.', '用預設正常等級壓，速度同壓縮率平衡。', 'Create', '建立', 'a -mx=5 {archive} {src}', { needsSource: true, destructive: true, keywords: 'normal level mx5 正常 等級' }),
  op('arc.level-maximum', 'Level: maximum (-mx=7)', '等級：最大（-mx=7）', 'Compress at the maximum level for a tighter archive.', '用最大等級壓，壓縮檔細啲。', 'Create', '建立', 'a -mx=7 {archive} {src}', { needsSource: true, destructive: true, keywords: 'maximum level mx7 最大 等級' }),
  op('arc.level-ultra', 'Level: ultra (-mx=9)', '等級：極致（-mx=9）', 'Compress at the ultra level for the smallest possible archive.', '用極致等級壓，搏壓到最細。', 'Create', '建立', 'a -mx=9 {archive} {src}', { needsSource: true, destructive: true, keywords: 'ultra level mx9 極致 等級' }),
  op('arc.dry-run-test', 'Dry-run test', '試行測試', 'Test the archive integrity without writing any extracted files.', '淨係測試壓縮檔完整性，唔會寫出任何解壓檔案。', 'Test', '測試', 't {archive}', { keywords: 'dryrun test integrity 試行 測試' }),

  // ===== RAR repair (unrar) =====
  op('arc.rar-repair', 'Repair RAR (recovery record)', '修復 RAR（復原記錄）', 'Repair the selected .rar using its embedded recovery record / recovery volumes via the RARLAB unrar CLI. 7-Zip cannot repair RAR.', '用 RARLAB unrar CLI，靠 RAR 內嵌嘅復原記錄／復原卷修復揀咗嗰個 .rar。7-Zip 修唔到 RAR。', 'Repair', '修復', 'r {archive}', { rar: true, destructive: true, keywords: 'rar repair recovery record 修復 復原 unrar' }),
  op('arc.rar-extract-keepbroken', 'Extract RAR (keep broken)', '解壓 RAR（保留壞檔）', 'Extract the selected .rar with -kb (keep broken) so partially-recovered files are written out. Uses the RARLAB unrar CLI.', '用 -kb（保留壞檔）解壓揀咗嗰個 .rar，部分救返嘅檔案會寫出嚟。用 RARLAB unrar CLI。', 'Extract', '解壓', 'x -kb {archive} {outdir}\\', { rar: true, destructive: true, keywords: 'rar extract keep broken kb 解壓 壞檔 unrar' }),
];

// Placeholder-substitution context for buildArgv.
interface ArgCtx {
  archive: string;
  src: string;
  outdir: string;
  password: string;
  entry: string;
  pattern: string;
}

// Parse an args template into an argv array, substituting the quoted paths. We
// split on whitespace but keep {archive}/{src}/{outdir}/{password}/{entry}/{pattern}
// placeholders intact so paths with spaces stay as single argv items (runCommand
// handles quoting per-arg, so we must NOT pre-quote).
function buildArgv(template: string, ctx: ArgCtx): string[] {
  const tokens = template.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (const tok of tokens) {
    if (tok === '{archive}') {
      if (ctx.archive) out.push(ctx.archive);
    } else if (tok === '{src}') {
      if (ctx.src) out.push(ctx.src);
    } else if (tok === '{entry}') {
      if (ctx.entry) out.push(ctx.entry);
    } else if (tok === '{pattern}') {
      if (ctx.pattern) out.push(ctx.pattern);
    } else if (tok.startsWith('-o{outdir}')) {
      out.push('-o' + ctx.outdir + tok.slice('-o{outdir}'.length));
    } else if (tok === '{outdir}\\' || tok === '{outdir}') {
      out.push(ctx.outdir + (tok.endsWith('\\') ? '\\' : ''));
    } else if (tok.startsWith('-p{password}')) {
      out.push('-p' + ctx.password + tok.slice('-p{password}'.length));
    } else {
      out.push(tok);
    }
  }
  return out;
}

// Derive a sibling "<name>_extracted" folder from the archive path.
function outDirFor(archive: string): string {
  const norm = archive.replace(/\\+$/, '');
  const slash = Math.max(norm.lastIndexOf('\\'), norm.lastIndexOf('/'));
  const dir = slash >= 0 ? norm.slice(0, slash) : '.';
  let base = slash >= 0 ? norm.slice(slash + 1) : norm;
  const dot = base.lastIndexOf('.');
  if (dot > 0) base = base.slice(0, dot);
  return `${dir}\\${base}_extracted`;
}

// One entry parsed out of a `7z l -slt` listing.
interface Entry {
  Path: string;
  Size: string;
  Modified: string;
  CRC: string;
  Attributes: string;
}

// Parse the "----------" block of `7z l -slt` into structured entries. Each entry
// is a run of "Key = Value" lines separated by blank lines. Windows PS 5.1 output
// is captured verbatim from runCommand stdout, so this stays pure string parsing.
function parseSlt(stdout: string): Entry[] {
  const marker = stdout.indexOf('----------');
  const body = marker >= 0 ? stdout.slice(marker + 10) : stdout;
  const blocks = body.split(/\r?\n\r?\n/);
  const rows: Entry[] = [];
  for (const block of blocks) {
    const kv: Record<string, string> = {};
    for (const line of block.split(/\r?\n/)) {
      const eq = line.indexOf(' = ');
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      const val = line.slice(eq + 3).trim();
      if (key) kv[key] = val;
    }
    const path = kv['Path'];
    if (!path) continue;
    const attrs = kv['Attributes'] ?? (kv['Folder'] === '+' ? 'D' : '');
    rows.push({
      Path: path,
      Size: kv['Size'] ?? '',
      Modified: kv['Modified'] ?? '',
      CRC: kv['CRC'] ?? '',
      Attributes: attrs,
    });
  }
  return rows;
}

const FORMATS = ['7z', 'zip', 'tar', 'gzip', 'bzip2', 'xz'] as const;

// Overwrite policies for the extraction control (7-Zip -ao* switches).
const OVERWRITE = [
  { value: '-aoa', enLabel: 'Overwrite all', zhLabel: '全部覆寫' },
  { value: '-aos', enLabel: 'Skip existing', zhLabel: '跳過已有' },
  { value: '-aou', enLabel: 'Auto-rename new', zhLabel: '新檔自動改名' },
  { value: '-aot', enLabel: 'Only if newer', zhLabel: '只係較新' },
] as const;

export function ArchivesModule() {
  const { t, i18n } = useTranslation();
  const zh = i18n.language.startsWith('zh');
  const pick = (en: string, canto: string) => (zh ? canto : en);

  const [archive, setArchive] = useState('');
  const [source, setSource] = useState('');
  const [entry, setEntry] = useState('');
  const [pattern, setPattern] = useState('');
  const [password, setPassword] = useState('');
  const [filter, setFilter] = useState('');
  const [output, setOutput] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);

  // Create-panel state
  const [format, setFormat] = useState<(typeof FORMATS)[number]>('7z');
  const [level, setLevel] = useState('5');
  const [volume, setVolume] = useState('');
  const [sfx, setSfx] = useState(false);
  const [headerEnc, setHeaderEnc] = useState(true);
  const [solid, setSolid] = useState(false);
  const [multithread, setMultithread] = useState(true);

  // Extract-panel state
  const [overwrite, setOverwrite] = useState<(typeof OVERWRITE)[number]['value']>('-aoa');

  // Contents tab state
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [entriesMsg, setEntriesMsg] = useState<string | null>(null);
  const [entriesFilter, setEntriesFilter] = useState('');

  // Resolve 7z.exe (registry + Program Files) and its version banner.
  const engine = useAsync<Engine>(async () => {
    const rows = await runPowershellJson<Engine>(`
      $cands = @()
      $reg = (Get-ItemProperty 'HKLM:\\SOFTWARE\\7-Zip' -ErrorAction SilentlyContinue).Path
      if ($reg) { $cands += (Join-Path $reg '7z.exe') }
      $cands += 'C:\\Program Files\\7-Zip\\7z.exe'
      $cands += 'C:\\Program Files (x86)\\7-Zip\\7z.exe'
      $exe = $cands | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
      $ver = ''
      if ($exe) {
        try { $ver = [string](Get-Item $exe).VersionInfo.ProductVersion } catch {}
      }
      if (-not $exe) { $exe = '' }
      if (-not $ver) { $ver = '' }
      [pscustomobject]@{ Installed = [bool]$exe -and $exe.Length -gt 0; Exe = $exe; Version = $ver }
    `);
    return rows[0] ?? { Installed: false, Exe: '', Version: '' };
  }, []);

  const exe = engine.data?.Exe ?? '';
  const installed = engine.data?.Installed ?? false;

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return OPERATIONS;
    return OPERATIONS.filter(
      (o) => `${o.enTitle} ${o.zhTitle} ${o.keywords}`.toLowerCase().includes(q),
    );
  }, [filter]);

  function argCtx(): ArgCtx {
    return {
      archive: archive.trim(),
      src: source.trim(),
      outdir: outDirFor(archive.trim()),
      password: password,
      entry: entry.trim(),
      pattern: pattern.trim(),
    };
  }

  // Low-level runner: builds argv from a template and shells out to 7z/unrar.
  async function runTemplate(id: string, program: string, template: string): Promise<boolean> {
    setBusy(id);
    setStatus(null);
    setOutput(pick('Running…', '執行緊…'));
    try {
      const argv = buildArgv(template, argCtx());
      const res = await runCommand(program, argv);
      const head = res.success ? pick('✓ Done', '✓ 完成') : pick('✗ Failed', '✗ 失敗');
      const body = [res.stdout, res.stderr].filter((s) => s.trim()).join('\n');
      setOutput(`${head}\n${body || pick('(no output)', '（冇輸出）')}`);
      setStatus({
        ok: res.success,
        text: res.success ? pick('Done', '完成') : pick('Failed', '失敗') + ` (exit ${res.code})`,
      });
      return res.success;
    } catch (e) {
      setOutput(String(e));
      setStatus({ ok: false, text: String(e) });
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function run(o: Op) {
    if (busy) return;
    if (o.needsArchive && !archive.trim()) {
      setStatus({ ok: false, text: pick('No archive selected.', '未揀壓縮檔。') });
      return;
    }
    if (o.needsSource && !source.trim()) {
      setStatus({ ok: false, text: pick('No source file/folder selected.', '未揀來源檔案／資料夾。') });
      return;
    }
    if (o.needsEntry && !entry.trim()) {
      setStatus({ ok: false, text: pick('Enter an entry name (Entry field).', '請喺項目欄輸入項目名。') });
      return;
    }
    if (o.needsPattern && !pattern.trim()) {
      setStatus({ ok: false, text: pick('Enter a wildcard pattern (Pattern field).', '請喺樣式欄輸入萬用字元樣式。') });
      return;
    }
    if (o.destructive) {
      const ok = window.confirm(
        `${o.enTitle} · ${o.zhTitle}\n\n${pick('This action writes/changes files and may be hard to undo. Proceed?', '呢個動作會寫入／改動檔案，可能難以復原。繼續？')}`,
      );
      if (!ok) return;
    }
    const program = o.rar ? 'unrar.exe' : exe || '7z.exe';
    await runTemplate(o.id, program, o.args);
  }

  // Build the Create argv from the panel controls (mirrors ArchiveService.Create).
  function createArgs(): string {
    const is7z = format === '7z';
    let s = `a -t${format} -mx=${level}`;
    if (password) {
      s += ' -p{password}';
      if (headerEnc && is7z) s += ' -mhe=on';
    }
    if (solid && is7z) s += ' -ms=on';
    if (multithread) s += ' -mmt=on';
    if (sfx && is7z) s += ' -sfx';
    if (volume.trim()) s += ` -v${volume.trim()}`;
    s += ' {archive} {src}';
    return s;
  }

  const createOp: Op = {
    id: 'arc.create',
    enTitle: 'Create archive',
    zhTitle: '建立壓縮檔',
    enDesc: '',
    zhDesc: '',
    enBtn: 'Create',
    zhBtn: '建立',
    args: createArgs(),
    needsArchive: true,
    needsSource: true,
    destructive: true,
    keywords: '',
  };

  // Extract-here with the chosen overwrite policy + optional password. Not
  // destructive-gated per se, but overwrite/only-newer touch existing files, so
  // we confirm whenever the policy can clobber on-disk files.
  async function extractWithPolicy() {
    if (busy) return;
    if (!archive.trim()) {
      setStatus({ ok: false, text: pick('No archive selected.', '未揀壓縮檔。') });
      return;
    }
    const clobbers = overwrite === '-aoa' || overwrite === '-aot';
    if (clobbers) {
      const ok = window.confirm(
        `${pick('Extract here', '解壓到旁邊')}\n\n${pick('This overwrites existing files in the target folder. Proceed?', '呢個會覆寫目標資料夾入面已有嘅檔案。繼續？')}`,
      );
      if (!ok) return;
    }
    const pw = password ? ' -p{password}' : '';
    await runTemplate('arc.extract-policy', exe || '7z.exe', `x {archive} -o{outdir} ${overwrite}${pw} -y`);
  }

  const quick: { id: string; label: string; op: Op }[] = [
    { id: 'q.list', label: pick('List', '列出'), op: OPERATIONS[0]! },
    { id: 'q.test', label: pick('Test', '測試'), op: OPERATIONS.find((o) => o.id === 'arc.inspect.test')! },
    { id: 'q.extract', label: pick('Extract here', '解壓到旁邊'), op: OPERATIONS.find((o) => o.id === 'arc.extract-full')! },
    { id: 'q.bench', label: pick('Benchmark', '效能測試'), op: OPERATIONS.find((o) => o.id === 'arc.benchmark')! },
  ];

  // ---- Contents tab: load & parse `l -slt` into structured entries ----
  async function loadContents() {
    if (!archive.trim()) {
      setEntriesMsg(pick('No archive selected.', '未揀壓縮檔。'));
      setEntries(null);
      return;
    }
    setBusy('contents.load');
    setEntriesMsg(pick('Reading…', '讀取緊…'));
    try {
      const argv = buildArgv('l -slt {archive}', argCtx());
      const res = await runCommand(exe || '7z.exe', argv);
      if (!res.success && !res.stdout.trim()) {
        setEntries(null);
        setEntriesMsg(res.stderr.trim() || pick('Failed to list contents.', '列唔到內容。'));
        return;
      }
      const rows = parseSlt(res.stdout);
      setEntries(rows);
      setEntriesMsg(rows.length ? null : pick('No entries found.', '搵唔到項目。'));
    } catch (e) {
      setEntries(null);
      setEntriesMsg(String(e));
    } finally {
      setBusy(null);
    }
  }

  // Extract a single parsed entry (click-gated) into the sibling _extracted folder.
  async function extractEntry(e: Entry) {
    if (busy) return;
    setBusy(`entry:${e.Path}`);
    setStatus(null);
    setOutput(pick('Running…', '執行緊…'));
    try {
      const pw = password ? ['-p' + password] : [];
      const ctx = argCtx();
      const argv = ['x', ctx.archive, '-o' + ctx.outdir, e.Path, ...pw, '-y'];
      const res = await runCommand(exe || '7z.exe', argv);
      const head = res.success ? pick('✓ Done', '✓ 完成') : pick('✗ Failed', '✗ 失敗');
      const body = [res.stdout, res.stderr].filter((s) => s.trim()).join('\n');
      setOutput(`${head}\n${body || pick('(no output)', '（冇輸出）')}`);
      setStatus({
        ok: res.success,
        text: res.success ? pick('Done', '完成') : pick('Failed', '失敗') + ` (exit ${res.code})`,
      });
    } catch (err) {
      setOutput(String(err));
      setStatus({ ok: false, text: String(err) });
    } finally {
      setBusy(null);
    }
  }

  const entryRows = useMemo(() => {
    const all = entries ?? [];
    const q = entriesFilter.trim().toLowerCase();
    return q ? all.filter((e) => e.Path.toLowerCase().includes(q)) : all;
  }, [entries, entriesFilter]);

  const entryColumns: Column<Entry>[] = [
    { key: 'Path', header: t('archives.colPath') },
    { key: 'Size', header: t('archives.colSize'), width: 110, align: 'right' },
    { key: 'Modified', header: t('archives.colModified'), width: 160 },
    { key: 'CRC', header: t('archives.colCrc'), width: 100 },
    {
      key: 'act',
      header: '',
      width: 120,
      render: (e) => (
        <button
          className="mini"
          disabled={!!busy || (!installed && !!exe)}
          onClick={() => extractEntry(e)}
        >
          {busy === `entry:${e.Path}` ? '…' : t('archives.extractEntry')}
        </button>
      ),
    },
  ];

  // ---------- Shared Selection + Create + Operations surface ----------
  const selectionPanel = (
    <fieldset className="io-grid" style={{ border: '1px solid var(--stroke-subtle)', borderRadius: 8, padding: 12, marginBottom: 12 }}>
      <legend style={{ fontWeight: 600, padding: '0 6px' }}>{t('archives.selection')}</legend>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 8 }}>
        <span className="count-note">{t('archives.archive')}</span>
        <input
          className="hosts-edit"
          placeholder={t('archives.archivePlaceholder')}
          value={archive}
          onChange={(e) => setArchive(e.target.value)}
        />
      </label>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 8 }}>
        <span className="count-note">{t('archives.source')}</span>
        <input
          className="hosts-edit"
          placeholder={t('archives.sourcePlaceholder')}
          value={source}
          onChange={(e) => setSource(e.target.value)}
        />
      </label>
      <div className="row-actions" style={{ flexWrap: 'wrap', gap: 8 }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1, minWidth: 180 }}>
          <span className="count-note">{t('archives.entry')}</span>
          <input
            className="hosts-edit"
            placeholder={t('archives.entryPlaceholder')}
            value={entry}
            onChange={(e) => setEntry(e.target.value)}
          />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1, minWidth: 180 }}>
          <span className="count-note">{t('archives.pattern')}</span>
          <input
            className="hosts-edit"
            placeholder={t('archives.patternPlaceholder')}
            value={pattern}
            onChange={(e) => setPattern(e.target.value)}
          />
        </label>
      </div>
    </fieldset>
  );

  const operationsTab = (
    <>
      {/* ---- Quick ops ---- */}
      <div className="row-actions" style={{ flexWrap: 'wrap', marginBottom: 12 }}>
        {quick.map((q) => (
          <button
            key={q.id}
            className="mini"
            disabled={!!busy || !installed}
            onClick={() => run(q.op)}
          >
            {busy === q.op.id ? '…' : q.label}
          </button>
        ))}
      </div>

      {/* ---- Extract with overwrite policy ---- */}
      <fieldset style={{ border: '1px solid var(--stroke-subtle)', borderRadius: 8, padding: 12, marginBottom: 12 }}>
        <legend style={{ fontWeight: 600, padding: '0 6px' }}>{t('archives.extractLabel')}</legend>
        <div className="row-actions" style={{ flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
          <span className="count-note">{t('archives.overwritePolicy')}</span>
          <select
            className="mod-select"
            value={overwrite}
            onChange={(e) => setOverwrite(e.target.value as (typeof OVERWRITE)[number]['value'])}
          >
            {OVERWRITE.map((o) => (
              <option key={o.value} value={o.value}>
                {pick(o.enLabel, o.zhLabel)}
              </option>
            ))}
          </select>
          <button
            className="mini primary"
            disabled={!!busy || !installed}
            onClick={extractWithPolicy}
          >
            {busy === 'arc.extract-policy' ? '…' : t('archives.extractHere')}
          </button>
        </div>
        <p className="count-note" style={{ margin: '8px 0 0' }}>{t('archives.extractNote')}</p>
      </fieldset>

      {/* ---- Create panel ---- */}
      <fieldset style={{ border: '1px solid var(--stroke-subtle)', borderRadius: 8, padding: 12, marginBottom: 12 }}>
        <legend style={{ fontWeight: 600, padding: '0 6px' }}>{t('archives.createLabel')}</legend>
        <div className="row-actions" style={{ flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
          <select className="mod-select" value={format} onChange={(e) => setFormat(e.target.value as (typeof FORMATS)[number])}>
            {FORMATS.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
          <select className="mod-select" value={level} onChange={(e) => setLevel(e.target.value)}>
            <option value="0">{t('archives.level0')}</option>
            <option value="1">{t('archives.level1')}</option>
            <option value="5">{t('archives.level5')}</option>
            <option value="9">{t('archives.level9')}</option>
          </select>
          <input
            className="hosts-edit"
            style={{ minWidth: 160, flex: 1 }}
            type="password"
            placeholder={t('archives.passwordPlaceholder')}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <input
            className="hosts-edit"
            style={{ width: 150 }}
            placeholder={t('archives.volumePlaceholder')}
            value={volume}
            onChange={(e) => setVolume(e.target.value)}
          />
        </div>
        <div className="row-actions" style={{ flexWrap: 'wrap', gap: 14, marginBottom: 8 }}>
          <label className="count-note"><input type="checkbox" checked={sfx} onChange={(e) => setSfx(e.target.checked)} /> {t('archives.sfx')}</label>
          <label className="count-note"><input type="checkbox" checked={headerEnc} onChange={(e) => setHeaderEnc(e.target.checked)} /> {t('archives.headerEnc')}</label>
          <label className="count-note"><input type="checkbox" checked={solid} onChange={(e) => setSolid(e.target.checked)} /> {t('archives.solid')}</label>
          <label className="count-note"><input type="checkbox" checked={multithread} onChange={(e) => setMultithread(e.target.checked)} /> {t('archives.multithread')}</label>
          <button className="mini primary" disabled={!!busy || !installed} onClick={() => run(createOp)}>
            {busy === createOp.id ? '…' : t('archives.create')}
          </button>
        </div>
        <p className="count-note" style={{ margin: 0 }}>{t('archives.rarNote')}</p>
      </fieldset>

      {status && <p className="mod-msg">{status.text}</p>}

      {output && (
        <pre className="cmd-out" style={{ maxHeight: 240, overflow: 'auto' }}>
          {output}
        </pre>
      )}

      {/* ---- Advanced operations ---- */}
      <h3 style={{ marginBottom: 8 }}>{t('archives.advanced', { total: OPERATIONS.length })}</h3>
      <ModuleToolbar>
        <input
          className="mod-search"
          placeholder={t('archives.filterOps')}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <span className="count-note">{t('archives.opCount', { shown: shown.length })}</span>
      </ModuleToolbar>

      <div className="dt-wrap">
        {shown.map((o) => (
          <div
            key={o.id}
            style={{
              display: 'flex',
              gap: 12,
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '8px 12px',
              borderBottom: '1px solid var(--stroke-subtle)',
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 600 }}>
                {pick(o.enTitle, o.zhTitle)}
                {o.destructive && <span className="count-note" style={{ marginLeft: 8, color: 'var(--danger)' }}>●</span>}
                {o.rar && <span className="count-note" style={{ marginLeft: 6 }}>RAR</span>}
              </div>
              <div className="count-note">{pick(o.enDesc, o.zhDesc)}</div>
            </div>
            <button
              className={`mini${o.destructive ? ' danger' : ''}`}
              disabled={!!busy || (o.rar ? false : !installed)}
              onClick={() => run(o)}
            >
              {busy === o.id ? '…' : pick(o.enBtn, o.zhBtn)}
            </button>
          </div>
        ))}
      </div>
    </>
  );

  const contentsTab = (
    <>
      <ModuleToolbar>
        <button className="mini primary" disabled={!!busy || !installed} onClick={loadContents}>
          {busy === 'contents.load' ? '…' : t('archives.readContents')}
        </button>
        <input
          className="mod-search"
          placeholder={t('archives.filterEntries')}
          value={entriesFilter}
          onChange={(e) => setEntriesFilter(e.target.value)}
        />
        {entries && <span className="count-note">{t('archives.entryCount', { shown: entryRows.length })}</span>}
      </ModuleToolbar>
      {entriesMsg && <p className="mod-msg">{entriesMsg}</p>}
      {entries && (
        <DataTable
          columns={entryColumns}
          rows={entryRows}
          rowKey={(e, i) => `${e.Path}#${i}`}
          empty={t('archives.noEntries')}
        />
      )}
      {!entries && !entriesMsg && (
        <p className="count-note">{t('archives.contentsHint')}</p>
      )}
      {output && (
        <pre className="cmd-out" style={{ maxHeight: 200, overflow: 'auto', marginTop: 10 }}>
          {output}
        </pre>
      )}
    </>
  );

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('archives.blurb')}
      </p>

      <ModuleToolbar>
        <button className="mini" onClick={engine.reload}>
          ⟳ {t('modules.refresh')}
        </button>
        <StatusDot
          ok={installed}
          label={
            installed
              ? `${t('archives.engineOk')}${engine.data?.Version ? ' · ' + engine.data.Version : ''}`
              : t('archives.engineMissing')
          }
        />
        {installed && exe && <span className="count-note">{exe}</span>}
      </ModuleToolbar>

      {!installed && !engine.loading && (
        <p className="mod-msg">{t('archives.installHint')}</p>
      )}

      {selectionPanel}

      <AsyncState loading={engine.loading} error={engine.error}>
        <ModuleTabs
          tabs={[
            { id: 'ops', en: 'Operations', zh: '操作', render: () => operationsTab },
            { id: 'contents', en: 'Contents', zh: '內容', render: () => contentsTab },
          ]}
        />
      </AsyncState>
    </div>
  );
}
