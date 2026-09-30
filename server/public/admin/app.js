'use strict';
const $=id=>document.getElementById(id);
const state={session:null,overview:null,page:'dashboard',recipientOffset:0,messageOffset:0,search:''};
function notice(text,error=false){$('notice').textContent=text;$('notice').classList.toggle('error',error);$('notice').hidden=false;}
const errors={CMS_LOGIN_REQUIRED:'Please sign in again.',INVALID_LOGIN:'Invalid login, authenticator code, or temporarily locked account. After repeated failures, wait 15 minutes.',MFA_REQUIRED:'Complete authenticator setup first.',INVALID_AUTHENTICATOR_CODE:'That code did not match. Check your phone clock and try the current code.',CMS_LOCAL_ONLY:'Open this console on the backend PC using its localhost CMS address.',INVALID_REQUEST:'Check the form values and change reference. Use letters, numbers, dots, slashes, underscores or hyphens for references.'};
async function api(path,body){
 const options={credentials:'same-origin',headers:{'X-CMS-Request':'1'}};
 if(body!==undefined){options.method='POST';options.headers['Content-Type']='application/json';options.headers['X-CSRF-Token']=state.session?.csrf??'';options.body=JSON.stringify(body);}
 const response=await fetch(new URL(`api${path}`, window.location.href),options);let result;
 try{result=await response.json();}catch{throw new Error('Server returned an unexpected response. Check that the API is running.');}
 if(!response.ok){if(response.status===401 && result.code==='CMS_LOGIN_REQUIRED'){state.session=null;showSession();}throw new Error(errors[result.code]??result.code??`Request failed (${response.status})`);}
 return result;
}
function run(fn){return async event=>{event?.preventDefault();try{await fn(event);}catch(error){notice(error.message,true);}};}
function formValues(form){return Object.fromEntries(new FormData(form));}
function result(title,value){$('result-title').textContent=title;$('result-text').textContent=JSON.stringify(value,null,2);$('result-dialog').showModal();}
function showSession(){
 $('login-panel').hidden=!!state.session;$('mfa-panel').hidden=!state.session?.mfaRequired;$('console').hidden=!state.session||state.session.mfaRequired;
 $('identity').textContent=state.session?`${state.session.username} · ${state.session.role}`:'';
}
function permissions(){document.querySelectorAll('[data-admin]').forEach(button=>button.disabled=state.session?.role!=='admin');}
function reason(action){return window.prompt('Change / evidence reference',`CMS-${action.toUpperCase()}`);}
async function command(command,reasonReference){
 reasonReference=reasonReference??reason(command.action);if(!reasonReference)return null;
 const response=await api('/command',{command,reasonReference});notice('Change saved.');return response;
}
function cell(value,mono=false){const el=document.createElement('span');el.textContent=value===null||value===undefined?'—':String(value);if(mono)el.className='mono';return el;}
function action(label,callback,danger=false){const button=document.createElement('button');button.textContent=label;button.dataset.admin='';if(danger)button.className='danger';button.addEventListener('click',run(callback));return button;}
function actions(...buttons){const div=document.createElement('div');div.className='actions';buttons.forEach(button=>div.append(button));return div;}
function table(target,headers,rows){
 const table=document.createElement('table'),head=document.createElement('thead'),tr=document.createElement('tr');
 for(const name of headers){const th=document.createElement('th');th.textContent=name;tr.append(th);}head.append(tr);table.append(head);
 const body=document.createElement('tbody');
 for(const values of rows){const row=document.createElement('tr');for(const value of values){const td=document.createElement('td');td.append(value instanceof Node?value:cell(value));row.append(td);}body.append(row);}
 if(!rows.length){const row=document.createElement('tr'),td=document.createElement('td');td.colSpan=headers.length;td.textContent='No records found.';row.append(td);body.append(row);}
 table.append(body);$(target).replaceChildren(table);permissions();
}
const date=value=>value?new Date(value).toLocaleString():'—';
const tenantName=id=>state.overview?.tenants.find(t=>t.id===id)?.name??id;
function fieldHelp(input,description){
 const help=document.createElement('small');help.className='field-help';help.id=`${input.form.id}-${input.name}-help`;help.textContent=description;
 input.setAttribute('aria-describedby',help.id);input.insertAdjacentElement('afterend',help);
}
const fieldDefinitions={
 recipient_quota:['Recipient quota / 24 hours',1,1000,'Maximum accepted messages to one number in the last 24 hours, across all clients and devices.'],
 cooldown_seconds:['Destination cooldown / seconds',0,86400,'Minimum wait between accepted messages to the same number. 300 seconds = 5 minutes; 0 disables the wait.'],
 client_quota:['Client quota / hour',1,10000,'Maximum accepted messages per API client in the last hour.'],
 device_quota:['Device quota / 24 hours',1,10000,'Maximum accepted messages per gateway phone in the last 24 hours, including STOP/START confirmations.'],
 message_ttl_seconds:['Queued message lifetime / seconds',60,86400,'How long a queued message may wait before it expires. 600 seconds = 10 minutes.'],
 replay_window_hours:['Duplicate-content window / hours',1,720,'Blocks identical text sent to the same number by the same tenant within this period.'],
 confirmation_cooldown_seconds:['STOP/START reply interval / seconds',30,86400,'Minimum wait between confirmations for the same keyword. STOP and START have separate timers; unchanged preferences get no new confirmation.']
};
for(const [name,[label,min,max,description]] of Object.entries(fieldDefinitions)){
 const el=document.createElement('label');el.textContent=label;const input=document.createElement('input');Object.assign(input,{name,type:'number',min,max,required:true});el.append(input);$('settings-fields').append(el);fieldHelp(input,description);
}
const formDescriptions={
 'login-form':{username:'Your CMS administrator username.',password:'Your CMS login password.',code:'Enter the current six-digit code from your authenticator app. Leave empty before your first setup.'},
 'mfa-form':{code:'Enter the current code for the account you just added to your authenticator app.'},
 'settings-form':{reasonReference:'A short reason or ticket code saved in the audit log, e.g. POLICY-001. Use no spaces.'},
 'consent-form':{tenantId:'The business or project receiving permission to message this number.',number:'The recipient\'s Pakistan mobile number, including country code, e.g. +923001234567.',evidenceReference:'A record or ticket code explaining the consent change, e.g. CONSENT-2026-001. Use no spaces.'},
 'device-form':{tenantId:'The business or project that owns this gateway phone.',simId:'Use the subscription ID shown under Confirm approved SIM in Android, not the phone number or SIM slot.'},
 'enrollment-form':{deviceId:'Choose the registered phone you want to pair. Only devices still needing pairing appear here.',publicKey:'Paste the complete key from Copy public key for operator in Android, including the BEGIN and END lines.'},
 'tenant-form':{name:'A recognizable name for your business or project. A tenant groups its devices, API clients and consent records.'},
 'client-form':{tenantId:'The business or project this API key will send messages for.'},
 'password-form':{currentPassword:'Enter the password you currently use to sign in to the CMS.',newPassword:'Choose a new CMS password with 12 to 256 characters.'}
};
for(const [formId,fields] of Object.entries(formDescriptions)){
 for(const [name,description] of Object.entries(fields))fieldHelp($(formId).elements.namedItem(name),description);
}
async function overview(){
 state.overview=await api('/overview');const data=state.overview;
 $('gateway-badge').textContent=data.settings.paused?'PAUSED':'ENABLED';$('gateway-badge').classList.toggle('paused',!!data.settings.paused);
 const counts=Object.fromEntries(data.counts.map(r=>[r.status,Number(r.count)]));
 $('stats').replaceChildren();
 for(const [label,value] of [['Registered devices',data.devices.length],['Queued today',counts.QUEUED??0],['Delivered today',counts.DELIVERED??0],['Uncertain today',counts.UNKNOWN??0]]){
   const div=document.createElement('div');div.className='stat';const strong=document.createElement('strong');strong.textContent=value;const span=document.createElement('span');span.textContent=label;div.append(strong,span);$('stats').append(div);
 }
 $('configuration').replaceChildren();
 for(const [label,value] of [['API address',`${data.configuration.apiHost}:${data.configuration.apiPort}`],['FCM worker enabled',data.configuration.fcmEnabled?'Yes':'No'],['Firebase project configured',data.configuration.firebaseConfigured?'Yes':'No'],['Credential file configured',data.configuration.credentialsConfigured?'Yes':'No'],['Admin access',window.location.origin]]){const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=label;dd.textContent=value;$('configuration').append(dt,dd);}
 for(const name of Object.keys(fieldDefinitions))$('settings-form').elements[name].value=data.settings[name];
 document.querySelectorAll('.tenant-select').forEach(select=>{const previous=select.value;select.replaceChildren();data.tenants.forEach(t=>{const option=document.createElement('option');option.value=t.id;option.textContent=`${t.name} (${t.id})`;select.append(option);});if(data.tenants.some(t=>t.id===previous))select.value=previous;});
 const deviceSelect=$('enrollment-device'),selected=deviceSelect.value;deviceSelect.replaceChildren();data.devices.filter(d=>!d.enrolled&&!d.revoked_at).forEach(d=>{const option=document.createElement('option');option.value=d.id;option.textContent=`${tenantName(d.tenant_id)} · ${d.id}`;deviceSelect.append(option);});if([...deviceSelect.options].some(o=>o.value===selected))deviceSelect.value=selected;
 table('device-table',['Device UUID','Tenant / SIM','Enrollment / FCM','Last seen','Status','Actions'],data.devices.map(d=>[
   cell(d.id,true),`${tenantName(d.tenant_id)} / ${d.allowed_sim_id}`,`${d.enrolled?'Enrolled':'Needs pairing'} / ${d.fcm_registered?'Registered':'No FCM token'}`,date(d.last_seen_at),d.revoked_at?'Revoked':d.paused?'Paused':'Enabled',d.revoked_at?'—':actions(
     action(d.paused?'Resume':'Pause',async()=>{if(await command({action:'device-pause',tenantId:d.tenant_id,deviceId:d.id,paused:!d.paused}))await refresh();}),
     action('Change SIM',async()=>{const sim=prompt('Approved SIM subscription ID (the device will be paused)',String(d.allowed_sim_id));if(sim===null)return;if(await command({action:'device-sim',tenantId:d.tenant_id,deviceId:d.id,simId:Number(sim)}))await refresh();}),
     action('Revoke',async()=>{if(!confirm('Revoke this device permanently? You will need a new identity to pair it again.'))return;if(await command({action:'device-revoke',tenantId:d.tenant_id,deviceId:d.id}))await refresh();},true))
 ]));
 table('client-table',['Client UUID','Tenant','Status','Actions'],data.clients.map(c=>[cell(c.id,true),tenantName(c.tenant_id),c.enabled?'Enabled':'Revoked',!c.enabled?'—':actions(
   action('Rotate key',async()=>{if(!confirm('Replace this API key? The old key stops working immediately.'))return;const response=await command({action:'client-rotate',tenantId:c.tenant_id,clientId:c.id});if(response){result('New API key',response);await refresh();}}),
   action('Revoke',async()=>{if(!confirm('Revoke this client and cancel pending jobs?'))return;if(await command({action:'client-revoke',tenantId:c.tenant_id,clientId:c.id}))await refresh();},true))]));
 permissions();$('updated').textContent=`Updated ${new Date().toLocaleTimeString()}`;
}
async function recipients(){const data=await api(`/recipients?search=${encodeURIComponent(state.search)}&offset=${state.recipientOffset}`);
 table('recipient-table',['Number','SMS preference','Manual suppression','Consent records','Usage / 24h','Next allowed','Actions'],data.recipients.map(r=>[r.normalized_e164,r.opted_out?'STOPPED':'STARTED',r.suppressed?'Blocked':'Clear',r.active_consents,r.daily_usage,date(r.next_allowed_at),actions(
   action(r.opted_out?'START':'STOP',async()=>{if(await command({action:'recipient-preference',number:r.normalized_e164,optedOut:!r.opted_out}))await recipients();},!r.opted_out),
   action(r.suppressed?'Clear manual block':'Manual block',async()=>{if(await command({action:'recipient-suppression',number:r.normalized_e164,suppressed:!r.suppressed}))await recipients();},!r.suppressed))]));
 $('recipient-prev').disabled=state.recipientOffset===0;$('recipient-next').disabled=data.recipients.length<50;
}
async function messages(){const data=await api(`/messages?offset=${state.messageOffset}`);table('message-table',['Job UUID','Recipient','Status','Type','Created','Expires'],data.messages.map(m=>[cell(m.id,true),m.normalized_e164,m.status,m.control_command??'Normal',date(m.created_at),date(m.expires_at)]));$('message-prev').disabled=state.messageOffset===0;$('message-next').disabled=data.messages.length<50;}
async function audit(){const data=await api('/audit');table('audit-table',['When','Action','Actor','Resource','Reference'],data.audit.map(a=>[date(a.recorded_at),a.action,cell(a.actor_id,true),cell(a.resource_id,true),a.reason_reference]));}
async function page(name){state.page=name;document.querySelectorAll('.page').forEach(el=>el.hidden=el.id!==name);document.querySelectorAll('[data-page]').forEach(el=>el.classList.toggle('active',el.dataset.page===name));if(name==='recipients')await recipients();if(name==='messages')await messages();if(name==='audit')await audit();}
async function refresh(){await overview();await page(state.page);}
$('login-form').addEventListener('submit',run(async()=>{const input=formValues($('login-form'));if(!input.code)delete input.code;state.session=await api('/login',input);$('login-form').reset();showSession();if(!state.session.mfaRequired)await refresh();}));
$('mfa-generate').addEventListener('click',run(async()=>{const data=await api('/mfa/setup',{});$('mfa-secret').textContent=`Account: ${data.account}\nSetup key: ${data.secret}`;$('mfa-secret').hidden=false;}));
$('mfa-form').addEventListener('submit',run(async()=>{const response=await api('/mfa/confirm',formValues($('mfa-form')));state.session.csrf=response.csrf;state.session.mfaRequired=false;$('mfa-secret').textContent='';$('mfa-secret').hidden=true;$('mfa-form').reset();showSession();notice('Authenticator enabled.');await refresh();}));
$('logout').addEventListener('click',run(async()=>{await api('/logout',{});state.session=null;location.reload();}));
$('refresh').addEventListener('click',run(refresh));
document.querySelectorAll('[data-page]').forEach(button=>button.addEventListener('click',run(()=>page(button.dataset.page))));
$('global-pause').addEventListener('click',run(async()=>{if(await command({action:'global-pause',paused:true}))await refresh();}));
$('global-resume').addEventListener('click',run(async()=>{if(await command({action:'global-pause',paused:false}))await refresh();}));
$('settings-form').addEventListener('submit',run(async()=>{const input=formValues($('settings-form')),settings={};Object.keys(fieldDefinitions).forEach(name=>settings[name]=Number(input[name]));if(await command({action:'settings-update',settings},input.reasonReference))await refresh();}));
$('recipient-search').addEventListener('submit',run(async()=>{state.search=formValues($('recipient-search')).search;state.recipientOffset=0;await recipients();}));
$('recipient-prev').addEventListener('click',run(async()=>{state.recipientOffset=Math.max(0,state.recipientOffset-50);await recipients();}));
$('recipient-next').addEventListener('click',run(async()=>{state.recipientOffset+=50;await recipients();}));
$('message-prev').addEventListener('click',run(async()=>{state.messageOffset=Math.max(0,state.messageOffset-50);await messages();}));
$('message-next').addEventListener('click',run(async()=>{state.messageOffset+=50;await messages();}));
$('consent-form').addEventListener('submit',run(async event=>{const data=formValues($('consent-form'));const commandData={action:event.submitter.value,tenantId:data.tenantId,number:data.number,purpose:'transactional_notification'};if(commandData.action==='consent-grant')commandData.evidenceReference=data.evidenceReference;if(await command(commandData,data.evidenceReference))await recipients();}));
$('device-form').addEventListener('submit',run(async()=>{const data=formValues($('device-form'));const commandData={action:'device-create',tenantId:data.tenantId,deviceId:crypto.randomUUID(),simId:Number(data.simId)};if(await command(commandData)){result('Enter this UUID in the Android app',{deviceId:commandData.deviceId,subscriptionId:commandData.simId});await refresh();}}));
$('enrollment-form').addEventListener('submit',run(async()=>{const data=formValues($('enrollment-form'));const device=state.overview.devices.find(d=>d.id===data.deviceId);if(!device)throw new Error('Select an unpaired device.');const response=await command({action:'device-enrollment',tenantId:device.tenant_id,deviceId:device.id,publicKey:data.publicKey.trim()});if(response){result('Enrollment token · valid for 10 minutes',response);$('enrollment-form').reset();await refresh();}}));
$('tenant-form').addEventListener('submit',run(async()=>{const response=await command({action:'tenant-create',...formValues($('tenant-form'))});if(response){$('tenant-form').reset();await refresh();}}));
$('client-form').addEventListener('submit',run(async()=>{const response=await command({action:'client-create',...formValues($('client-form'))});if(response){result('API key · shown once',response);await refresh();}}));
$('password-form').addEventListener('submit',run(async()=>{await api('/password',formValues($('password-form')));$('password-form').reset();state.session=null;showSession();notice('Password changed. Sign in with your new password and authenticator code.');}));
$('result-close').addEventListener('click',()=>{$('result-dialog').close();$('result-text').textContent='';});
$('result-dialog').addEventListener('close',()=>{$('result-text').textContent='';});
(async()=>{try{state.session=await api('/session');showSession();if(!state.session.mfaRequired)await refresh();}catch(error){showSession();if(!error.message.includes('sign in'))notice(error.message,true);}})();
