'use strict';
Object.assign(errors,{
 CMS_PERMISSION_DENIED:'Your account does not have permission for this section.',CMS_TENANT_DENIED:'This tenant is not assigned to your account.',
 CMS_GLOBAL_ACCESS_REQUIRED:'This action affects all tenants and requires all-tenant access.',SUPER_ADMIN_REQUIRED:'Only a super administrator can manage CMS users.',
 CMS_CANNOT_EDIT_SELF:'Use Account to change your password. Another super administrator must change your access.',
 CMS_LAST_SUPER_ADMIN:'Keep at least one enabled super administrator with an enrolled authenticator.',
 CMS_USERNAME_EXISTS:'That username is already in use.',CMS_USER_NOT_FOUND:'This CMS account was not found.',
});
const cmsUserState={users:[],tenants:[],editing:null};
const cmsSectionLabels={dashboard:'Overview / global pause',settings:'Limits & settings',recipients:'Recipients & consent',contacts:'Contacts & groups',bulk:'Bulk messaging',devices:'Devices',clients:'Tenants & API keys',messages:'Message history',audit:'Audit log'};
const usersButton=document.createElement('button');usersButton.dataset.page='users';usersButton.textContent='CMS users';usersButton.hidden=true;
usersButton.addEventListener('click',run(()=>page('users')));document.querySelector('nav').insertBefore(usersButton,document.querySelector('[data-page="account"]'));
const usersPage=document.createElement('section');usersPage.id='users';usersPage.className='page';usersPage.hidden=true;
usersPage.innerHTML=`
 <p class="eyebrow">PEOPLE & ACCESS</p><h1>CMS users</h1>
 <p class="muted">Create accounts, assign tenants and control access to each section. Every new user must set up an authenticator. Only super administrators can manage CMS accounts.</p>
 <div id="cms-user-table" class="table-wrap"></div>
 <form id="cms-user-form" class="card"><div class="heading"><h2 id="cms-user-form-title">Create a CMS account</h2><button type="button" id="cms-user-new" class="secondary">New account</button></div>
 <div class="form-grid"><label>Username<input name="username" minlength="3" maxlength="80" pattern="[a-z0-9_.-]{3,80}" required autocomplete="off"><small class="field-help">Lowercase letters, digits, dots, underscores and hyphens.</small></label>
 <label>Account type<select name="type"><option value="admin">Delegated administrator</option><option value="viewer">Read-only viewer</option><option value="super">Super administrator</option></select></label>
 <label>Status<select name="enabled"><option value="true">Enabled</option><option value="false">Disabled</option></select></label></div>
 <label class="check-label"><input name="allTenants" type="checkbox"> Access all tenants, including future tenants</label>
 <fieldset id="cms-user-tenant-fieldset"><legend>Assigned tenants</legend><div id="cms-user-tenants" class="group-options"></div><p class="field-help">Select one or more tenants. An account with no tenants cannot access tenant data.</p></fieldset>
 <div id="cms-user-rights"><h2>Section permissions</h2><p class="muted">Manage includes View. Global settings and gateway pause require all-tenant access. Tenant-scoped recipients permission can manage consent; shared STOP/manual suppression controls require all-tenant access.</p><div id="cms-user-permissions" class="form-grid"></div></div>
 <p id="cms-user-super-note" class="muted" hidden>Super administrators have full access to all tenants, sections and CMS user management.</p>
 <label class="narrow">Change reference<input name="reasonReference" value="CMS-USER-ACCESS" pattern="[A-Za-z0-9_.:/-]{3,128}" required></label>
 <p class="field-help">New passwords are generated and displayed once. Changing access signs the user out. Removing sending access cancels their unattempted scheduled batches for the affected tenants.</p>
 <button id="cms-user-save" data-admin>Create account</button>
 </form>`;
$('console').append(usersPage);
for(const [section,label] of Object.entries(cmsSectionLabels)){
 const wrapper=document.createElement('label');wrapper.textContent=label;const select=document.createElement('select');select.name=`permission_${section}`;
 for(const [value,text] of [['none','No access'],['view','View'],['manage','Manage']])select.add(new Option(text,value));
 wrapper.append(select);$('cms-user-permissions').append(wrapper);
}
function updateCmsUserForm(){
 const form=$('cms-user-form'),superAdmin=form.elements.type.value==='super',viewer=form.elements.type.value==='viewer';
 if(superAdmin)form.elements.allTenants.checked=true;
 form.elements.allTenants.disabled=superAdmin;
 $('cms-user-tenant-fieldset').hidden=form.elements.allTenants.checked;
 $('cms-user-rights').hidden=superAdmin;$('cms-user-super-note').hidden=!superAdmin;
 for(const section of Object.keys(cmsSectionLabels)){
  const select=form.elements[`permission_${section}`],manage=select.querySelector('[value="manage"]');
  manage.disabled=viewer||(!form.elements.allTenants.checked&&['dashboard','settings'].includes(section))||['messages','audit'].includes(section);
  if(manage.disabled&&select.value==='manage')select.value='view';
 }
}
function newCmsUser(){
 cmsUserState.editing=null;$('cms-user-form').reset();$('cms-user-form').elements.username.disabled=false;
 $('cms-user-tenants').querySelectorAll('input').forEach(input=>input.checked=false);
 $('cms-user-form-title').textContent='Create a CMS account';$('cms-user-save').textContent='Create account';updateCmsUserForm();
}
function editCmsUser(user){
 cmsUserState.editing=user.id;const form=$('cms-user-form');form.elements.username.value=user.username;form.elements.username.disabled=true;
 form.elements.type.value=user.access.superAdmin?'super':user.role;form.elements.enabled.value=String(user.enabled);form.elements.allTenants.checked=user.access.allTenants;
 for(const section of Object.keys(cmsSectionLabels))form.elements[`permission_${section}`].value=user.access.permissions[section]??'none';
 $('cms-user-tenants').querySelectorAll('input').forEach(input=>input.checked=user.access.tenantIds.includes(input.value));
 $('cms-user-form-title').textContent=`Edit access: ${user.username}`;$('cms-user-save').textContent='Save access';updateCmsUserForm();form.scrollIntoView({behavior:'smooth'});
}
async function loadCmsUsers(){
 const data=await api('/users');cmsUserState.users=data.users;cmsUserState.tenants=data.tenants;
 const checked=new Set([...$('cms-user-tenants').querySelectorAll('input:checked')].map(input=>input.value));$('cms-user-tenants').replaceChildren();
 for(const tenant of data.tenants){const label=document.createElement('label');label.className='check-label';const input=document.createElement('input');input.type='checkbox';input.value=tenant.id;input.checked=checked.has(tenant.id);label.append(input,document.createTextNode(`${tenant.name}${tenant.enabled?'':' (disabled)'}`));$('cms-user-tenants').append(label);}
 if(!data.tenants.length)$('cms-user-tenants').append(cell('Create tenants first, or grant all-tenant access.'));
 table('cms-user-table',['Username','Type','Tenant access','Sections','Status / MFA','Actions'],data.users.map(user=>{
  const tenantNames=user.access.allTenants?'All tenants':user.access.tenantIds.map(id=>data.tenants.find(tenant=>tenant.id===id)?.name??id).join(', ')||'No tenants';
  const rights=user.access.superAdmin?'All sections':Object.entries(user.access.permissions).filter(([,level])=>level!=='none').map(([section,level])=>`${cmsSectionLabels[section]}: ${level}`).join(' · ')||'No section access';
  const controls=user.id===state.session.access.id?cell('Your account'):actions(action('Edit access',()=>editCmsUser(user)),action('Reset password',async()=>{
   if(!confirm(`Generate a new password for ${user.username}? Existing sessions will be signed out. Their authenticator stays enrolled.`))return;
   const response=await api('/users',{action:'reset-password',userId:user.id,reasonReference:'CMS-PASSWORD-RESET'});result('New CMS password — save it now',response);notice('Password reset. Share it securely with the account owner.');
  }));
  return [user.username,user.access.superAdmin?'Super admin':user.role,tenantNames,rights,`${user.enabled?'Enabled':'Disabled'} / ${user.mfaEnabled?'MFA enrolled':'MFA setup needed'}`,controls];
 }));updateCmsUserForm();
}
$('cms-user-new').addEventListener('click',newCmsUser);
$('cms-user-form').elements.type.addEventListener('change',updateCmsUserForm);
$('cms-user-form').elements.allTenants.addEventListener('change',updateCmsUserForm);
$('cms-user-form').addEventListener('submit',run(async()=>{
 const form=$('cms-user-form'),superAdmin=form.elements.type.value==='super';
 const access={role:superAdmin?'admin':form.elements.type.value,superAdmin,allTenants:form.elements.allTenants.checked,enabled:form.elements.enabled.value==='true',tenantIds:[...$('cms-user-tenants').querySelectorAll('input:checked')].map(input=>input.value),permissions:Object.fromEntries(Object.keys(cmsSectionLabels).map(section=>[section,superAdmin?'none':form.elements[`permission_${section}`].value]))};
 const payload={action:cmsUserState.editing?'update':'create',...(cmsUserState.editing?{userId:cmsUserState.editing}:{username:form.elements.username.value}),access,reasonReference:form.elements.reasonReference.value};
 $('cms-user-save').disabled=true;
 try{const response=await api('/users',payload);if(response.password)result('New CMS account — save the password now',response);newCmsUser();await loadCmsUsers();notice('CMS account saved.');}finally{$('cms-user-save').disabled=!can('users',true);}
}));
