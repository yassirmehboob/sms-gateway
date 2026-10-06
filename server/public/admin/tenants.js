'use strict';
const tenantSettingsForm=document.createElement('form');
tenantSettingsForm.id='tenant-settings-form';tenantSettingsForm.className='card';
tenantSettingsForm.innerHTML='<h2>Tenant settings</h2><label>Tenant<select id="settings-tenant" class="tenant-select" required></select></label><p>Unchecked fields inherit the current platform default. Clear all overrides to restore defaults.</p><div id="tenant-settings-fields" class="form-grid"></div><label>Change reference<input name="reasonReference" value="CMS-TENANT-SETTINGS" required></label><button data-admin>Save tenant settings</button>';
$('settings').append(tenantSettingsForm);
for(const [name,[label,min,max,description]] of Object.entries(fieldDefinitions)){
 const wrap=document.createElement('div'),choice=document.createElement('label'),check=document.createElement('input'),inputLabel=document.createElement('label'),input=document.createElement('input');
 choice.className='override-choice';Object.assign(check,{type:'checkbox',name:`override_${name}`});choice.append(check,document.createTextNode('Override default'));
 inputLabel.textContent=label;Object.assign(input,{type:'number',name,min,max,required:true});inputLabel.append(input);wrap.append(choice,inputLabel);$('tenant-settings-fields').append(wrap);fieldHelp(input,description);
 check.addEventListener('change',()=>input.disabled=!check.checked||!can('settings',true,true));
}
let tenantSettingsRequest=0;
async function loadTenantSettings(){
 const tenantId=$('settings-tenant').value;if(!tenantId||!can('settings'))return;
 const requestId=++tenantSettingsRequest;
 for(const element of tenantSettingsForm.elements)if(element!==$('settings-tenant'))element.disabled=true;
 const data=await api(`/tenant-settings?tenantId=${encodeURIComponent(tenantId)}`);
 if(requestId!==tenantSettingsRequest||tenantId!==$('settings-tenant').value)return;
 tenantSettingsForm.elements.reasonReference.disabled=!can('settings',true,true);
 tenantSettingsForm.querySelector('button').disabled=!can('settings',true,true);
 for(const name of Object.keys(fieldDefinitions)){
  const check=tenantSettingsForm.elements[`override_${name}`],input=tenantSettingsForm.elements[name];
  check.checked=Object.hasOwn(data.overrides,name);check.disabled=!can('settings',true,true);input.value=data.effective[name];input.disabled=!check.checked||check.disabled;
 }
}
$('settings-tenant').addEventListener('change',run(loadTenantSettings));
tenantSettingsForm.addEventListener('submit',run(async()=>{
 const overrides={};for(const name of Object.keys(fieldDefinitions))if(tenantSettingsForm.elements[`override_${name}`].checked)overrides[name]=Number(tenantSettingsForm.elements[name].value);
 if(await command({action:'tenant-settings-update',tenantId:$('settings-tenant').value,overrides},tenantSettingsForm.elements.reasonReference.value))await refresh();
}));
const tenantTable=document.createElement('div');tenantTable.id='tenant-table';tenantTable.className='table-wrap';$('client-table').before(tenantTable);
const expiryForm=document.createElement('form');expiryForm.id='tenant-expiry-form';expiryForm.className='card';
expiryForm.innerHTML='<h2>Subscription expiry</h2><label>Tenant<select name="tenantId" id="expiry-tenant" class="tenant-select" required></select></label><label>Service expiry (local time)<input name="expiresAt" type="datetime-local"></label><p>Leave empty for no expiry. Expiry blocks tenant services and cancels unsent messages and scheduled batches. Renewing allows new activity; cancelled messages stay cancelled.</p><label>Change reference<input name="reasonReference" value="CMS-TENANT-RENEWAL" required></label><button data-admin data-global>Save expiry</button>';
$('clients').append(expiryForm);
function fillExpiry(){const tenant=state.overview?.tenants.find(t=>t.id===$('expiry-tenant').value),value=tenant?.expires_at;const d=value?new Date(value):null;expiryForm.elements.expiresAt.value=d?new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16):'';}
$('expiry-tenant').addEventListener('change',fillExpiry);
expiryForm.addEventListener('submit',run(async()=>{const values=formValues(expiryForm);if(await command({action:'tenant-expiry-update',tenantId:values.tenantId,expiresAt:values.expiresAt?new Date(values.expiresAt).toISOString():null},values.reasonReference))await refresh();}));
const subscriptionNotice=document.createElement('p');subscriptionNotice.className='card';subscriptionNotice.id='subscription-notice';$('console').querySelector('.toolbar').after(subscriptionNotice);
async function renderTenantServices(){
 $('settings-form').hidden=!state.session.access.allTenants;
 expiryForm.hidden=!can('clients',true,true);
 const expired=state.overview.tenants.filter(t=>t.service_status!=='ACTIVE');
 subscriptionNotice.hidden=!expired.length;subscriptionNotice.textContent=expired.map(t=>`${t.name}: ${t.service_status.toLowerCase()}.`).join(' ')+' Tenant services are restricted until renewed by the platform administrator.';
 if(can('clients'))table('tenant-table',['Tenant','Service status','Expiry','Bulk interval'],state.overview.tenants.map(t=>[t.name,t.service_status,t.expires_at?date(t.expires_at):'No expiry',`${t.bulk_delay_seconds} seconds`]));
 fillExpiry();
}
