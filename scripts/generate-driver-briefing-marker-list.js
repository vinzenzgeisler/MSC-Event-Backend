'use strict';
const fs = require('node:fs');
const path = require('node:path');
const PDFDocument = require('pdfkit');
const { Client } = require('pg');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
const collator = new Intl.Collator('de-DE', { sensitivity: 'base', numeric: true });

async function loadRows() {
  const secretResponse = await new SecretsManagerClient({ region: 'eu-central-1' }).send(
    new GetSecretValueCommand({ SecretId: process.env.DB_SECRET_ARN })
  );
  const secret = JSON.parse(secretResponse.SecretString);
  const db = new Client({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 5432),
    database: process.env.DB_NAME || 'eventdb',
    user: secret.username,
    password: secret.password,
    ssl: { rejectUnauthorized: true, ca: fs.readFileSync('C:\\tmp\\rds-global-bundle.pem', 'utf8') }
  });
  await db.connect();
  try {
    await db.query('begin transaction isolation level repeatable read read only');
    const result = await db.query(`
      with accepted as (
        select e.id entry_id, e.class_id, e.driver_person_id, e.codriver_person_id,
               e.start_number_norm, ev.name event_name, c.name class_name
        from entry e join event ev on ev.id=e.event_id join class c on c.id=e.class_id
        where ev.is_current=true and e.acceptance_status='accepted' and e.deleted_at is null
      ), people as (
        select a.*, p.id person_id, 'driver'::text participant_role,
          case when nullif(btrim(p.publication_name),'') is not null then btrim(p.publication_name)
               else concat_ws(', ',nullif(btrim(p.last_name),''),nullif(btrim(p.first_name),'')) end display_name
        from accepted a join person p on p.id=a.driver_person_id
        where p.processing_restricted=false and p.objection_flag=false
        union all
        select a.*, p.id person_id, 'codriver'::text participant_role,
          case when nullif(btrim(p.publication_name),'') is not null then btrim(p.publication_name)
               else concat_ws(', ',nullif(btrim(p.last_name),''),nullif(btrim(p.first_name),'')) end display_name
        from accepted a join person p on p.id=a.codriver_person_id
        where p.processing_restricted=false and p.objection_flag=false
        union all
        select a.*, p.id person_id, 'codriver'::text participant_role,
          case when nullif(btrim(p.publication_name),'') is not null then btrim(p.publication_name)
               else concat_ws(', ',nullif(btrim(p.last_name),''),nullif(btrim(p.first_name),'')) end display_name
        from accepted a join entry_charity_codriver ecc on ecc.entry_id=a.entry_id and ecc.status='active'
        join person p on p.id=ecc.person_id
        where p.processing_restricted=false and p.objection_flag=false
      )
      select distinct on (entry_id,person_id,participant_role)
        event_name,entry_id,class_id,class_name,start_number_norm,person_id,participant_role,display_name
      from people where nullif(btrim(display_name),'') is not null
      order by entry_id,person_id,participant_role
    `);
    await db.query('rollback');
    return result.rows;
  } finally { await db.end(); }
}

function prepare(rows) {
  const driverEntries = new Map();
  const codriverClasses = new Map();
  for (const row of rows) {
    const map = row.participant_role === 'driver' ? driverEntries : codriverClasses;
    if (!map.has(row.person_id)) map.set(row.person_id, new Set());
    map.get(row.person_id).add(row.participant_role === 'driver' ? row.entry_id : row.class_id);
  }
  const annotated = rows.map((row) => ({ ...row,
    marker: row.participant_role === 'driver' && driverEntries.get(row.person_id).size > 1 ? '2×'
      : row.participant_role === 'codriver' && codriverClasses.get(row.person_id).size > 1 ? '2K' : ''
  }));
  const grouped = new Map();
  for (const row of annotated) {
    if (!grouped.has(row.class_name)) grouped.set(row.class_name, []);
    grouped.get(row.class_name).push(row);
  }
  for (const items of grouped.values()) items.sort((a,b) =>
    collator.compare(a.start_number_norm || '',b.start_number_norm || '')
    || (a.participant_role === b.participant_role ? 0 : a.participant_role === 'driver' ? -1 : 1)
    || collator.compare(a.display_name,b.display_name));
  return { annotated, groups:[...grouped.entries()].sort(([a],[b]) => collator.compare(a,b)) };
}

async function render(eventName, groups, outputPath, show2K) {
  const doc = new PDFDocument({ size:'A4', layout:'landscape', autoFirstPage:false,
    margins:{ top:0,right:0,bottom:0,left:0 },
    info:{ Title:`Fahrerbesprechung – Anwesenheit – ${eventName}`, Author:'MSC Oberlausitzer Dreiländereck e. V.' } });
  doc.registerFont('Regular','C:\\Windows\\Fonts\\arial.ttf');
  doc.registerFont('Bold','C:\\Windows\\Fonts\\arialbd.ttf');
  const stream = fs.createWriteStream(outputPath); doc.pipe(stream);
  const PW=841.89, PH=595.28, left=30, totalWidth=PW-60;
  const weight=[55,78,300,181,181], weightTotal=weight.reduce((a,b)=>a+b,0);
  const widths=weight.map(v=>v*totalWidth/weightTotal);
  const headers=['STARTNR.','ROLLE','NAME','SAMSTAG – UNTERSCHRIFT','SONNTAG – UNTERSCHRIFT'];
  const generatedAt=new Intl.DateTimeFormat('de-DE',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',timeZone:'Europe/Berlin'}).format(new Date());
  const rowHeight=30, tableTop=116, tableBottom=PH-47;
  let cursorY=tableTop, pageNo=0;

  function addPage(className,classRows,continued) {
    doc.addPage(); pageNo += 1;
    doc.font('Bold').fontSize(8.2).fillColor('#163A70').text('MSC OBERLAUSITZER DREILÄNDERECK E.V.',left,23,{width:totalWidth,characterSpacing:.6,lineBreak:false});
    doc.font('Bold').fontSize(17).fillColor('#0F172A').text('Fahrerbesprechung – Anwesenheit',left,39,{width:totalWidth,lineBreak:false});
    doc.font('Regular').fontSize(7.8).fillColor('#64748B').text(`${eventName} · Erstellt am ${generatedAt}`,left,61,{width:480,lineBreak:false});
    doc.font('Bold').fontSize(7.4).fillColor('#8A5B00').text(show2K?'2× Doppelstarter · 2K Beifahrer in mehreren Klassen':'2× Doppelstarter',left+490,61,{width:totalWidth-490,align:'right',lineBreak:false});
    const drivers=classRows.filter(r=>r.participant_role==='driver').length;
    doc.font('Bold').fontSize(10).fillColor('#163A70').text(`${className}${continued?' · Fortsetzung':''}`,left,82,{width:570,lineBreak:false,ellipsis:true});
    doc.font('Regular').fontSize(8).fillColor('#64748B').text(`${drivers} Fahrer · ${classRows.length-drivers} Beifahrer`,left+580,84,{width:totalWidth-580,align:'right',lineBreak:false});
    doc.save().lineWidth(1.2).strokeColor('#E6B800').moveTo(left,101).lineTo(left+totalWidth,101).stroke().restore();
    cursorY=tableTop; let x=left;
    headers.forEach((header,i)=>{ doc.save().rect(x,cursorY,widths[i],26).fill('#163A70').restore();
      doc.font('Bold').fontSize(7.2).fillColor('#FFF').text(header,x+5,cursorY+8,{width:widths[i]-10,align:i===0||i>=3?'center':'left',lineBreak:false,ellipsis:true}); x+=widths[i]; });
    cursorY+=26;
    const footerY=PH-33;
    doc.save().lineWidth(.6).strokeColor('#D8DEE9').moveTo(left,footerY-6).lineTo(left+totalWidth,footerY-6).stroke().restore();
    doc.font('Regular').fontSize(7.4).fillColor('#64748B').text('Interne Anwesenheitsliste',left,footerY,{width:totalWidth/2,lineBreak:false});
    doc.text(`Seite ${pageNo}`,left+totalWidth/2,footerY,{width:totalWidth/2,align:'right',lineBreak:false});
  }

  function drawRow(row,index) {
    let x=left;
    widths.forEach((cellWidth,column)=>{
      doc.save().rect(x,cursorY,cellWidth,rowHeight).fill(index%2===0?'#FFFFFF':'#F8FAFC').restore();
      doc.save().lineWidth(.5).strokeColor('#CBD5E1').rect(x,cursorY,cellWidth,rowHeight).stroke().restore();
      if(column===0) doc.font('Bold').fontSize(9).fillColor('#0F172A').text(clean(row.start_number_norm)||'–',x+5,cursorY+8,{width:cellWidth-10,align:'center',lineBreak:false});
      if(column===1) doc.font('Regular').fontSize(8.2).fillColor('#0F172A').text(row.participant_role==='driver'?'Fahrer':'Beifahrer',x+6,cursorY+8,{width:cellWidth-12,lineBreak:false,ellipsis:true});
      if(column===2){ const nameX=x+7,badgeWidth=row.marker?23:0,maxNameWidth=cellWidth-14-(row.marker?29:0);
        doc.font('Regular').fontSize(8.6).fillColor('#0F172A').text(clean(row.display_name),nameX,cursorY+8,{width:maxNameWidth,lineBreak:false,ellipsis:true});
        if(row.marker){ const measured=Math.min(doc.widthOfString(clean(row.display_name)),maxNameWidth); const badgeX=Math.min(nameX+measured+5,x+cellWidth-badgeWidth-6);
          doc.save().roundedRect(badgeX,cursorY+8,badgeWidth,13,6).fill('#E6B800').restore();
          doc.font('Bold').fontSize(6.8).fillColor('#17365D').text(row.marker,badgeX,cursorY+11,{width:badgeWidth,align:'center',lineBreak:false}); }
      }
      x+=cellWidth;
    }); cursorY+=rowHeight;
  }

  for(const [className,rows] of groups){ addPage(className,rows,false); let rowIndex=0;
    for(const row of rows){ if(cursorY+rowHeight>tableBottom){ addPage(className,rows,true); rowIndex=0; } drawRow(row,rowIndex++); }
  }
  doc.end(); await new Promise((resolve,reject)=>stream.on('finish',resolve).on('error',reject)); return pageNo;
}

async function main(){ const prepared=prepare(await loadRows()); if(!prepared.annotated.length) throw new Error('Keine Teilnehmer gefunden.');
  const outputPath=path.resolve(process.argv[2]||'05-fahrerbesprechung-anwesenheit-mit-marker.pdf'); fs.mkdirSync(path.dirname(outputPath),{recursive:true});
  const multi=new Set(prepared.annotated.filter(r=>r.participant_role==='codriver'&&r.marker).map(r=>r.person_id));
  const pages=await render(clean(prepared.annotated[0].event_name),prepared.groups,outputPath,multi.size>0);
  console.log(JSON.stringify({outputPath,classes:prepared.groups.length,rows:prepared.annotated.length,pages,
    doubleStarters:new Set(prepared.annotated.filter(r=>r.participant_role==='driver'&&r.marker).map(r=>r.person_id)).size,multiClassCodrivers:multi.size})); }
main().catch(error=>{console.error(error.stack||error.message);process.exitCode=1;});
