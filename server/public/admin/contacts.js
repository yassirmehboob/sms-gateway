'use strict';
const contactState={tenantId:'',groups:[],selected:new Map(),offset:0,search:'',filter:'',preview:null,campaignOffset:0,detailId:null,detailOffset:0,submission:null};
Object.assign(errors,{
 MESSAGE_TOO_LONG:'The final message must fit one SMS: 160 GSM units or 70 Unicode units, including the opt-out footer.',
 INVALID_MESSAGE_BODY:'Enter a non-empty message without unsupported control characters.',
 IMPORT_HEADERS_REQUIRED:'The first row must contain Name and Mobile_no. Optional columns: Address and Email address.',
 IMPORT_DUPLICATE_HEADER:'Each Excel column header must be unique.',INVALID_EXCEL_FILE:'Upload an unencrypted .xlsx Excel workbook.',
 IMPORT_EMPTY:'The first worksheet has no contact rows.',IMPORT_FILE_TOO_LARGE:'The Excel file must be no larger than 2 MB.',
 IMPORT_TOO_MANY_ROWS:'Use up to 1,000 contact rows and 20 columns in the first worksheet.',
 CAMPAIGN_RECIPIENT_LIMIT:'Choose between 1 and 1,000 unique recipients.',GROUP_EXISTS:'A group with this name already exists for this tenant.',
 INVALID_SCHEDULE:'Choose a future start time within the next year.',CAMPAIGN_FINISHED:'This batch has already completed or been cancelled.',
 INSUFFICIENT_SCOPE:'Choose an enabled API client with SMS sending permission.',
});
for(const [id,label] of [['contacts','Contacts & groups'],['bulk','Bulk messaging']]){
 const button=document.createElement('button');button.dataset.page=id;button.textContent=label;
 button.addEventListener('click',run(()=>page(id)));
 document.querySelector('nav').insertBefore(button,document.querySelector('[data-page="devices"]'));
}
const contactPage=document.createElement('section');contactPage.id='contacts';contactPage.className='page';contactPage.hidden=true;
contactPage.innerHTML=`
 <div class="heading"><div><p class="eyebrow">ADDRESS BOOK</p><h1>Contacts & groups</h1></div><a class="download-link" href="./api/contacts/template">Download Excel template</a></div>
 <label class="narrow">Tenant<select id="contacts-tenant" class="tenant-select"></select></label>
 <p class="muted">Add contacts individually or import an Excel workbook. Contacts can belong to several groups. Permission to send is checked separately.</p>
 <div class="grid">
  <form id="contact-form" class="card"><h2>Add or update a contact</h2>
   <label>Name<input name="name" required maxlength="200"></label><label>Mobile_no<input name="mobile" type="tel" placeholder="03001234567" required maxlength="30"></label>
   <label>Address (optional)<input name="address" maxlength="500"></label><label>Email address (optional)<input name="email" type="email" maxlength="254"></label>
   <label>Add to group (optional)<select name="groupId" class="contact-group-select"></select></label>
   <label>Consent evidence reference (optional)<input name="evidenceReference" maxlength="128" pattern="[A-Za-z0-9_.:/-]{3,128}" placeholder="PARENT-REGISTRATION-2026"><small class="field-help">Only supply this if permission has already been collected. Existing revoked consent and STOP preferences remain in effect.</small></label>
   <button data-admin>Save contact</button><p class="field-help">Saving an existing mobile number updates its name, address and email.</p>
  </form>
  <div><form id="contact-import-form" class="card"><h2>Import Excel contacts</h2>
   <p class="muted">First worksheet: Name, Mobile_no, Address (optional), Email address (optional). Up to 1,000 rows, 2 MB, .xlsx format. Store mobile numbers as text.</p>
   <label>Excel workbook<input id="contacts-file" name="file" type="file" accept=".xlsx" required></label>
   <label>Add imported contacts to group (optional)<select name="groupId" class="contact-group-select"></select></label>
   <label>Consent evidence for these contacts (optional)<input name="evidenceReference" maxlength="128" pattern="[A-Za-z0-9_.:/-]{3,128}" placeholder="PARENT-REGISTRATION-2026"><small class="field-help">Confirms permission already collected for every imported contact. Leave blank to import without recording consent.</small></label>
   <button data-admin>Preview import</button>
   <div id="import-preview" hidden><p id="import-summary"></p><div id="import-errors" class="table-wrap"></div><div id="import-rows" class="table-wrap"></div><button id="import-confirm" type="button" data-admin>Import valid contacts</button><p class="field-help">Invalid rows are excluded. Existing numbers keep their saved details and are added to the selected group.</p></div>
  </form>
  <form id="group-form" class="card"><h2>Create a group</h2><label>Group name<input name="name" placeholder="Class 8 parents" maxlength="200" required></label><button data-admin>Create group</button></form></div>
 </div>
 <form id="contact-search-form" class="contact-filters"><label>Search name or mobile<input name="search" maxlength="200"></label><label>Filter by group<select id="contact-group-filter" class="contact-group-select"></select></label><button>Search</button></form>
 <div class="selection-bar"><strong id="contact-selected">0 contacts selected</strong><button id="contacts-select-page" class="secondary">Select this page</button><button id="contacts-clear" class="secondary">Clear selection</button><button id="contacts-compose" data-admin>Message selected contacts</button></div>
 <div id="contacts-table" class="table-wrap"></div><div class="actions"><button id="contacts-prev" class="secondary">Previous</button><span id="contact-count" class="muted"></span><button id="contacts-next" class="secondary">Next</button></div>
 <form id="membership-form" class="card"><h2>Manage selected contacts in a group</h2><label class="narrow">Group<select name="groupId" id="membership-group" class="contact-group-select" required></select></label><div class="actions"><button value="add" data-admin>Add to group</button><button value="remove" class="secondary" data-admin>Remove from group</button></div></form>
`;
$('console').append(contactPage);
const bulkPage=document.createElement('section');bulkPage.id='bulk';bulkPage.className='page';bulkPage.hidden=true;
bulkPage.innerHTML=`
 <p class="eyebrow">BATCHES & SCHEDULES</p><h1>Bulk messaging</h1>
 <label class="narrow">Tenant<select id="bulk-tenant" class="tenant-select"></select></label>
 <p class="muted">Send transactional notifications to selected contacts, groups, or both. Duplicate recipients are included once. Consent, STOP, suppression and quotas apply to every recipient.</p>
 <form id="campaign-form" class="card"><h2>Compose a message batch</h2><div class="form-grid">
  <label>Batch name<input name="name" placeholder="Class 8 attendance reminder" maxlength="200" required></label>
  <label>Sending API client<select name="clientId" id="campaign-client" required></select></label>
  <label>Schedule start (optional)<input name="scheduledAt" type="datetime-local"><small id="schedule-zone" class="field-help"></small></label>
 </div>
 <fieldset><legend>Recipient groups (optional)</legend><div id="campaign-groups" class="group-options"></div></fieldset>
 <p id="campaign-selected" class="muted"></p><button type="button" id="campaign-pick" class="secondary">Select individual contacts</button>
 <label>Message<textarea id="campaign-body" name="body" rows="4" maxlength="4096" required dir="auto"></textarea></label>
 <label class="check-label"><input name="includeOptOut" type="checkbox"> Append “Reply STOP to unsubscribe”</label><p id="campaign-length" class="field-help"></p>
 <p id="campaign-pacing" class="muted"></p><p class="field-help">The start time is the earliest release time. Quotas, device availability and pacing can delay delivery. Unreleased recipients expire seven days after the scheduled start. No automatic resend after a send attempt.</p>
 <label class="narrow">Change reference<input name="reasonReference" value="CMS-BULK-MESSAGE" pattern="[A-Za-z0-9_.:/-]{3,128}" required></label>
 <button id="campaign-submit" data-admin>Create message batch</button>
 </form>
 <h2>Message batches</h2><div id="campaign-table" class="table-wrap"></div><div class="actions"><button id="campaign-prev" class="secondary">Previous</button><button id="campaign-next" class="secondary">Next</button></div>
 <section id="campaign-detail" class="card" hidden><h2 id="campaign-detail-title">Recipient results</h2><p class="muted">COMPLETED means processing finished, not that every message was delivered. Skipped and uncertain results are listed here.</p><div id="campaign-recipient-table" class="table-wrap"></div><div class="actions"><button id="campaign-detail-prev" class="secondary">Previous</button><button id="campaign-detail-next" class="secondary">Next</button></div></section>
`;
$('console').append(bulkPage);
$('contacts-compose').dataset.permission='bulk';
$('campaign-pick').dataset.admin='';$('campaign-pick').dataset.permission='contacts';$('campaign-pick').dataset.view='';
$('schedule-zone').textContent=`Your timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}. Leave blank to start now.`;
let visibleContacts=[];
function selectedContactSummary(){
 $('contact-selected').textContent=`${contactState.selected.size} contacts selected`;
 $('campaign-selected').textContent=`${contactState.selected.size} individually selected contacts. Selections remain when you change pages or filters.`;
}
function requireContactTenant(){if(!contactState.tenantId)throw new Error('Create or select a tenant first.');return contactState.tenantId;}
function resetImport(){contactState.preview=null;$('import-preview').hidden=true;}
function resetContactContext(tenantId){
 contactState.tenantId=tenantId;contactState.selected.clear();contactState.offset=0;contactState.campaignOffset=0;contactState.filter='';contactState.detailId=null;contactState.submission=null;
 $('contacts-tenant').value=tenantId;$('bulk-tenant').value=tenantId;$('campaign-detail').hidden=true;resetImport();selectedContactSummary();
}
async function loadContactGroups(){
 const checked=new Set([...document.querySelectorAll('#campaign-groups input:checked')].map(input=>input.value));
 contactState.groups=(await api(`/groups?tenantId=${encodeURIComponent(requireContactTenant())}`)).groups;
 for(const select of document.querySelectorAll('.contact-group-select')){
  const previous=select.value;select.replaceChildren(new Option(select.id==='contact-group-filter'?'All contacts':'Choose a group', ''));
  for(const group of contactState.groups)select.add(new Option(`${group.name} (${group.members})`,group.id));
  if(contactState.groups.some(group=>group.id===previous))select.value=previous;
 }
 $('contact-group-filter').value=contactState.filter;
 $('campaign-groups').replaceChildren();
 for(const group of contactState.groups){const label=document.createElement('label');label.className='check-label';const checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.value=group.id;checkbox.checked=checked.has(group.id);label.append(checkbox,document.createTextNode(`${group.name} (${group.members})`));$('campaign-groups').append(label);}
 if(!contactState.groups.length)$('campaign-groups').append(cell('No groups yet. Create one in Contacts & groups.'));
 const select=$('campaign-client'),previous=select.value;select.replaceChildren();
 for(const client of state.overview.clients.filter(c=>c.tenant_id===contactState.tenantId&&c.enabled)){
  const scopes=typeof client.scopes==='string'?JSON.parse(client.scopes):client.scopes;if(!scopes.includes('sms:send'))continue;
  select.add(new Option(client.id,client.id));
 }
 if([...select.options].some(option=>option.value===previous))select.value=previous;
 $('campaign-pacing').textContent=`Bulk interval: ${(state.overview.tenants.find(t=>t.id===contactState.tenantId)?.bulk_delay_seconds??state.overview.settings.bulk_delay_seconds)} seconds, configured in Limits & settings. Carrier-approved limits and all existing quotas still apply.`;
}
async function loadContactsPage(name){
 const tenant=(name==='contacts'?$('contacts-tenant'):$('bulk-tenant')).value;
 if(tenant!==contactState.tenantId)resetContactContext(tenant);
 if(!tenant){notice('Create a tenant in Tenants & API keys to manage contacts.');return;}
 await loadContactGroups();selectedContactSummary();
 if(name==='contacts')await loadContacts();else await loadCampaigns();permissions();
}
async function loadContacts(){
 const data=await api(`/contacts?tenantId=${requireContactTenant()}&search=${encodeURIComponent(contactState.search)}&offset=${contactState.offset}${contactState.filter?`&groupId=${contactState.filter}`:''}`);
 visibleContacts=data.contacts;
 table('contacts-table',['Select','Name','Mobile_no','Address','Email address','Sending permission','Edit'],data.contacts.map(contact=>{
  const checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.className='contact-checkbox';checkbox.checked=contactState.selected.has(contact.id);checkbox.setAttribute('aria-label',`Select ${contact.name}`);
  checkbox.addEventListener('change',()=>{if(checkbox.checked){if(contactState.selected.size>=1000){checkbox.checked=false;notice('Select up to 1,000 contacts.',true);return;}contactState.selected.set(contact.id,contact.name);}else contactState.selected.delete(contact.id);selectedContactSummary();});
  return [checkbox,contact.name,contact.normalized_e164,contact.address,contact.email,contact.opted_out?'STOPPED':contact.suppressed?'Manually blocked':contact.consent?'Consent recorded':'Consent needed',action('Edit',()=>{
   const form=$('contact-form');for(const [name,value] of Object.entries({name:contact.name,mobile:contact.normalized_e164,address:contact.address??'',email:contact.email??'',evidenceReference:''}))form.elements[name].value=value;
   form.scrollIntoView({behavior:'smooth'});
  })];
 }));
 $('contact-count').textContent=`${data.total?data.offset+1:0}–${data.offset+data.contacts.length} of ${data.total}`;
 $('contacts-prev').disabled=contactState.offset===0;$('contacts-next').disabled=contactState.offset+50>=data.total;selectedContactSummary();
}
for(const id of ['contacts-tenant','bulk-tenant'])$(id).addEventListener('change',run(async()=>{resetContactContext($(id).value);await loadContactsPage(id==='contacts-tenant'?'contacts':'bulk');}));
$('contact-form').addEventListener('submit',run(async()=>{
 const values=formValues($('contact-form'));await api('/contacts',{tenantId:requireContactTenant(),contact:{name:values.name,mobile:values.mobile,address:values.address,email:values.email},...(values.groupId?{groupId:values.groupId}:{}),...(values.evidenceReference?{evidenceReference:values.evidenceReference}:{}),reasonReference:'CMS-CONTACT-SAVE'});
 $('contact-form').reset();notice('Contact saved.');await loadContactGroups();await loadContacts();
}));
$('group-form').addEventListener('submit',run(async()=>{await api('/groups',{tenantId:requireContactTenant(),name:formValues($('group-form')).name,reasonReference:'CMS-GROUP-CREATE'});$('group-form').reset();await loadContactGroups();notice('Group created.');}));
$('contact-search-form').addEventListener('submit',run(async()=>{contactState.search=formValues($('contact-search-form')).search;contactState.filter=$('contact-group-filter').value;contactState.offset=0;await loadContacts();}));
$('contacts-prev').addEventListener('click',run(async()=>{contactState.offset=Math.max(0,contactState.offset-50);await loadContacts();}));
$('contacts-next').addEventListener('click',run(async()=>{contactState.offset+=50;await loadContacts();}));
$('contacts-select-page').addEventListener('click',run(async()=>{for(const contact of visibleContacts){if(contactState.selected.size>=1000&&!contactState.selected.has(contact.id))break;contactState.selected.set(contact.id,contact.name);}await loadContacts();}));
$('contacts-clear').addEventListener('click',run(async()=>{contactState.selected.clear();await loadContacts();}));
$('contacts-compose').addEventListener('click',run(()=>page('bulk')));
$('campaign-pick').addEventListener('click',run(()=>page('contacts')));
$('membership-form').addEventListener('submit',run(async event=>{
 if(!contactState.selected.size)throw new Error('Select contacts from the table first.');
 await api('/group-members',{tenantId:requireContactTenant(),groupId:formValues($('membership-form')).groupId,contactIds:[...contactState.selected.keys()],remove:event.submitter.value==='remove',reasonReference:'CMS-GROUP-MEMBERS'});
 await loadContactGroups();await loadContacts();notice('Group membership updated.');
}));
$('contacts-file').addEventListener('change',resetImport);
$('contact-import-form').addEventListener('submit',run(async()=>{
 resetImport();const tenantId=requireContactTenant(),file=$('contacts-file').files[0];
 if(!file||!file.name.toLowerCase().endsWith('.xlsx'))throw new Error('Choose an .xlsx Excel workbook.');
 if(file.size>2*1024*1024)throw new Error('The Excel file must be no larger than 2 MB.');
 const base64=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(new Error('Could not read the file.'));reader.readAsDataURL(file);});
 const preview=await api('/contacts/import/preview',{tenantId,base64});
 if(tenantId!==contactState.tenantId)return;
 contactState.preview={...preview,tenantId};$('import-preview').hidden=false;
 $('import-summary').textContent=`${preview.rows.length} valid contacts; ${preview.errors.length} invalid rows; ${preview.duplicates} duplicates in file; ${preview.existing} already saved. Preview below shows the first 20 valid rows.`;
 table('import-errors',['Excel row','Problem'],preview.errors.map(error=>[error.row,error.message]));
 table('import-rows',['Excel row','Name','Mobile_no'],preview.rows.slice(0,20).map(row=>[row.row,row.name,row.mobile]));
 $('import-confirm').disabled=!preview.rows.length||!can('contacts',true);
}));
$('import-confirm').addEventListener('click',run(async()=>{
 const preview=contactState.preview;if(!preview||!preview.rows.length)throw new Error('Preview a workbook first.');
 const input=formValues($('contact-import-form'));$('import-confirm').disabled=true;
 try{
  const response=await api('/contacts/import',{tenantId:preview.tenantId,contacts:preview.rows.map(({row,...contact})=>contact),...(input.groupId?{groupId:input.groupId}:{}),...(input.evidenceReference?{evidenceReference:input.evidenceReference}:{}),reasonReference:'CMS-EXCEL-IMPORT'});
  resetImport();$('contact-import-form').reset();await loadContactGroups();await loadContacts();notice(`Imported ${response.added} new contacts; ${response.existing} existing contacts retained.`);
 }finally{$('import-confirm').disabled=!can('contacts',true);}
}));
const cmsGsmBasic=new Set(Array.from('@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà'));
const cmsGsmExtended=new Set(Array.from('\f^{}\\[~]|€'));
function campaignLength(){
 const form=$('campaign-form'),body=form.elements.body.value+(form.elements.includeOptOut.checked?'\nReply STOP to unsubscribe':'');let gsm=true,units=0;
 for(const char of body){if(cmsGsmBasic.has(char))units++;else if(cmsGsmExtended.has(char))units+=2;else gsm=false;}
 if(!gsm)units=body.length;const limit=gsm?160:70;
 $('campaign-length').textContent=`${gsm?'GSM':'Unicode'}: ${units} / ${limit} units, including any footer. ${units>limit?'Shorten the message to fit one SMS.':''}`;
 $('campaign-body').setCustomValidity(units>limit?'The final message exceeds the single-SMS limit.':'');
}
$('campaign-form').addEventListener('input',campaignLength);campaignLength();
$('campaign-form').addEventListener('submit',run(async()=>{
 const form=$('campaign-form'),values=formValues(form),groupIds=[...document.querySelectorAll('#campaign-groups input:checked')].map(input=>input.value),contactIds=[...contactState.selected.keys()];
 if(!groupIds.length&&!contactIds.length)throw new Error('Choose at least one group or contact.');
 const scheduled=values.scheduledAt?new Date(values.scheduledAt):null;
 if(scheduled&&scheduled.getTime()<=Date.now())throw new Error('Choose a future start time or leave it blank to start now.');
 const payload={tenantId:requireContactTenant(),clientId:values.clientId,name:values.name,body:values.body,includeOptOut:form.elements.includeOptOut.checked,contactIds,groupIds,...(scheduled?{scheduledAt:scheduled.toISOString()}:{}),reasonReference:values.reasonReference};
 if(!confirm(`Create this message batch for ${contactIds.length} selected contacts and ${groupIds.length} groups? Duplicate recipients are removed. Start: ${scheduled?scheduled.toLocaleString():'now'}. Existing sending permissions and quotas apply.`))return;
 const signature=JSON.stringify(payload);
 if(contactState.submission?.signature!==signature)contactState.submission={signature,id:crypto.randomUUID()};
 $('campaign-submit').disabled=true;
 try{
  const created=await api('/campaigns',{...payload,id:contactState.submission.id});
  contactState.submission=null;contactState.selected.clear();form.reset();document.querySelectorAll('#campaign-groups input').forEach(input=>input.checked=false);campaignLength();selectedContactSummary();contactState.campaignOffset=0;
  notice(`Message batch saved${created.recipients?` for ${created.recipients} recipients`:''}. Track progress below.`);await loadCampaigns();
 }finally{$('campaign-submit').disabled=!can('bulk',true);}
}));
async function controlCampaign(campaign,operation){
 if(operation==='cancel'&&!confirm('Cancel recipients that have not been attempted? Already authorized sends cannot be recalled.'))return;
 await api('/campaigns/control',{tenantId:requireContactTenant(),id:campaign.id,action:operation,reasonReference:`CMS-BATCH-${operation.toUpperCase()}`});
 notice(`Batch ${operation==='pause'?'paused':operation==='resume'?'resumed':'cancelled'}. Already authorized sends cannot be recalled.${operation==='pause'?' Queued jobs retain their expiry time.':''}`);await loadCampaigns();
}
async function loadCampaigns(){
 const data=await api(`/campaigns?tenantId=${requireContactTenant()}&offset=${contactState.campaignOffset}`);
 table('campaign-table',['Batch','Start','State','Progress','Actions'],data.campaigns.map(campaign=>{
  const details=document.createElement('button');details.className='secondary';details.textContent='Recipient results';details.addEventListener('click',run(async()=>{contactState.detailId=campaign.id;contactState.detailOffset=0;$('campaign-detail-title').textContent=`${campaign.name}: recipient results`;await campaignDetails();}));
  const controls=[details];if(['ACTIVE','PAUSED'].includes(campaign.status))controls.push(action(campaign.status==='PAUSED'?'Resume':'Pause',()=>controlCampaign(campaign,campaign.status==='PAUSED'?'resume':'pause')),action('Cancel',()=>controlCampaign(campaign,'cancel'),true));
  return [campaign.name,date(campaign.scheduled_at),campaign.status==='ACTIVE'&&new Date(campaign.scheduled_at)>new Date()?'SCHEDULED':campaign.status,`${campaign.total} total · ${campaign.pending} pending · ${campaign.queued} queued · ${campaign.sent} sent · ${campaign.delivered} delivered · ${campaign.skipped} skipped · ${campaign.cancelled} cancelled · ${campaign.unresolved} expired/failed/unknown`,actions(...controls)];
 }));
 $('campaign-prev').disabled=contactState.campaignOffset===0;$('campaign-next').disabled=data.campaigns.length<50;
 if(contactState.detailId)await campaignDetails();
}
async function campaignDetails(){
 const data=await api(`/campaigns/${contactState.detailId}/recipients?tenantId=${requireContactTenant()}&offset=${contactState.detailOffset}`);
 $('campaign-detail').hidden=false;
 table('campaign-recipient-table',['Name','Mobile_no','Status','Reason / last wait','Next eligibility check'],data.recipients.map(row=>[row.name,row.normalized_e164,row.status,row.last_error,row.status==='PENDING'?date(row.next_attempt_at):'—']));
 $('campaign-detail-prev').disabled=contactState.detailOffset===0;$('campaign-detail-next').disabled=data.recipients.length<50;
}
$('campaign-prev').addEventListener('click',run(async()=>{contactState.campaignOffset=Math.max(0,contactState.campaignOffset-50);await loadCampaigns();}));
$('campaign-next').addEventListener('click',run(async()=>{contactState.campaignOffset+=50;await loadCampaigns();}));
$('campaign-detail-prev').addEventListener('click',run(async()=>{contactState.detailOffset=Math.max(0,contactState.detailOffset-50);await campaignDetails();}));
$('campaign-detail-next').addEventListener('click',run(async()=>{contactState.detailOffset+=50;await campaignDetails();}));
