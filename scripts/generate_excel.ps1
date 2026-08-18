$ArtifactDir = "C:\Users\intco\Documents\New project 3\logs\codex-runs\20260521155901-1x1271\artifacts"
$OutFile = Join-Path $ArtifactDir "generated.xlsx"
$ZipFile = Join-Path $ArtifactDir "generated.zip"
$BuildDir = Join-Path $ArtifactDir "xlsx_build"

if (Test-Path -LiteralPath $BuildDir) {
  Remove-Item -LiteralPath $BuildDir -Recurse -Force
}

if (Test-Path -LiteralPath $OutFile) {
  Remove-Item -LiteralPath $OutFile -Force
}

if (Test-Path -LiteralPath $ZipFile) {
  Remove-Item -LiteralPath $ZipFile -Force
}

New-Item -ItemType Directory -Path $BuildDir | Out-Null
New-Item -ItemType Directory -Path (Join-Path $BuildDir "_rels") | Out-Null
New-Item -ItemType Directory -Path (Join-Path $BuildDir "docProps") | Out-Null
New-Item -ItemType Directory -Path (Join-Path $BuildDir "xl") | Out-Null
New-Item -ItemType Directory -Path (Join-Path $BuildDir "xl\\_rels") | Out-Null
New-Item -ItemType Directory -Path (Join-Path $BuildDir "xl\\worksheets") | Out-Null

Set-Content -LiteralPath (Join-Path $BuildDir "[Content_Types].xml") -Encoding UTF8 -Value @"
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>
"@

Set-Content -LiteralPath (Join-Path $BuildDir "_rels\\.rels") -Encoding UTF8 -Value @"
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>
"@

Set-Content -LiteralPath (Join-Path $BuildDir "docProps\\core.xml") -Encoding UTF8 -Value @"
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:creator>Codex</dc:creator>
  <cp:lastModifiedBy>Codex</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">2026-05-21T15:59:01Z</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">2026-05-21T15:59:01Z</dcterms:modified>
</cp:coreProperties>
"@

Set-Content -LiteralPath (Join-Path $BuildDir "docProps\\app.xml") -Encoding UTF8 -Value @"
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>Codex</Application>
</Properties>
"@

Set-Content -LiteralPath (Join-Path $BuildDir "xl\\workbook.xml") -Encoding UTF8 -Value @"
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="Sheet1" sheetId="1" r:id="rId1"/>
  </sheets>
</workbook>
"@

Set-Content -LiteralPath (Join-Path $BuildDir "xl\\_rels\\workbook.xml.rels") -Encoding UTF8 -Value @"
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>
"@

Set-Content -LiteralPath (Join-Path $BuildDir "xl\\worksheets\\sheet1.xml") -Encoding UTF8 -Value @"
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1">
      <c r="A1" t="inlineStr"><is><t>Generated</t></is></c>
    </row>
  </sheetData>
</worksheet>
"@

Compress-Archive -Path (Join-Path $BuildDir "*") -DestinationPath $ZipFile -Force
Move-Item -LiteralPath $ZipFile -Destination $OutFile -Force
Remove-Item -LiteralPath $BuildDir -Recurse -Force

Write-Output $OutFile
