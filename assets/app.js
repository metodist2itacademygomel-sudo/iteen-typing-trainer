import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cfg = window.APP_CONFIG || {};
const configured = cfg.SUPABASE_URL && !cfg.SUPABASE_URL.includes('YOUR-PROJECT') && cfg.SUPABASE_ANON_KEY && !cfg.SUPABASE_ANON_KEY.includes('YOUR_');
const supabase = configured ? createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY) : null;
const $ = (id) => document.getElementById(id);
const panel = $('mainPanel');
const teacherOverlay = $('teacherOverlay');
const teacherContent = $('teacherContent');
let currentGroup = null;
let currentStudent = null;
let currentLesson = null;
let timerHandle = null;
let remaining = 600;
let startedAt = null;
let resultSaved = false;
let mistakeCount = 0;
let teacherUser = null;
let teacherGroup = null;
let teacherTab = 'students';
let soundOn = false;

const esc = (v='') => String(v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmtTime = (s) => `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;
const fmtDate = (s) => new Date(s).toLocaleDateString('ru-RU',{day:'2-digit',month:'2-digit',year:'numeric'});
const showMsg = (id, text, bad=false) => { const el=$(id); if(el){el.textContent=text;el.className=bad?'tp-note err':'tp-note';} };
function setLead(text){$('lead').textContent=text;}
function setPanel(html, color='var(--tw-sky)'){panel.style.setProperty('--mc',color);panel.innerHTML=html;}
function noConfig(){setPanel(`<div class="ph"><span class="tag">Настройка</span><h2>Почти готово!</h2><p>Для запуска нужно подключить бесплатную базу Supabase. Инструкция есть в файле README.</p></div><div class="alert">Откройте <b>config.js</b> и укажите URL проекта и публичный anon key из Supabase. Секретный service_role key сюда вставлять нельзя.</div>`);}

async function init(){
  if(!supabase){noConfig();return;}
  await loadGroups();
  const {data:{session}} = await supabase.auth.getSession();
  if(session){teacherUser=session.user; await refreshTeacherGroup();}
}

async function loadGroups(){
  const {data,error}=await supabase.rpc('student_portal_groups');
  if(error){setPanel(`<div class="ph"><span class="tag">Подключение</span><h2>Не удалось загрузить группы</h2><p>${esc(error.message)}</p></div><button class="btn" id="retryGroups">Повторить</button>`);$('retryGroups')?.addEventListener('click',loadGroups);return;}
  const groups=data||[];
  if(!groups.length){setPanel(`<div class="ph"><span class="tag">Добро пожаловать</span><h2>Пока нет учебных групп</h2><p>Попроси педагога создать группу и добавить твоё имя.</p></div><div class="guide"><div class="bubble">Как только педагог создаст группу, она появится здесь!</div></div>`);return;}
  setPanel(`<div class="ph"><span class="tag">Шаг 1</span><h2>Выбери свою группу</h2><p>Найди группу, в которой проходит твоё занятие.</p></div><div class="choice-grid">${groups.map(g=>`<button class="choice-card" data-group="${g.id}"><strong>${esc(g.name)}</strong><small>Нажми, чтобы продолжить →</small></button>`).join('')}</div>`);
  panel.querySelectorAll('[data-group]').forEach(b=>b.addEventListener('click',()=>chooseGroup(groups.find(g=>g.id===b.dataset.group))));
}

async function chooseGroup(group){
  currentGroup=group;
  const {data,error}=await supabase.rpc('student_portal_data',{p_group_id:group.id});
  if(error){setPanel(`<div class="ph"><h2>Не удалось открыть группу</h2><p>${esc(error.message)}</p></div><button class="btn ghost" id="backGroups">Назад</button>`);$('backGroups').onclick=loadGroups;return;}
  const roster=data?.students||[];
  if(!roster.length){setPanel(`<div class="ph"><span class="tag">${esc(group.name)}</span><h2>Список пока пуст</h2><p>Попроси педагога добавить тебя в группу.</p></div><button class="btn ghost" id="backGroups">Выбрать другую группу</button>`);$('backGroups').onclick=loadGroups;return;}
  setPanel(`<div class="ph"><span class="tag">Шаг 2 · ${esc(group.name)}</span><h2>Кто сегодня занимается?</h2><p>Найди своё имя в списке.</p></div><div class="name-grid">${roster.map(s=>`<button class="name-card" data-student="${s.id}">👤 ${esc(s.display_name)}</button>`).join('')}</div><div class="row"><button class="btn ghost small" id="backGroups">← Назад</button></div>`);
  panel.querySelectorAll('[data-student]').forEach(b=>b.addEventListener('click',()=>chooseStudent(roster.find(s=>s.id===b.dataset.student))));
  $('backGroups').onclick=loadGroups;
}

async function chooseStudent(student){
  currentStudent=student;
  const {data,error}=await supabase.rpc('student_portal_data',{p_group_id:currentGroup.id});
  if(error){setPanel(`<p>${esc(error.message)}</p>`);return;}
  currentLesson=data?.lesson||null;
  if(!currentLesson){setPanel(`<div class="ph"><span class="tag">${esc(currentGroup.name)}</span><h2>Привет, ${esc(student.display_name)}!</h2><p>Педагог ещё не опубликовал текст. Можно вернуться чуть позже.</p></div><div class="row"><button class="btn ghost" id="backNames">Выбрать другое имя</button></div>`);$('backNames').onclick=()=>chooseGroup(currentGroup);return;}
  setPanel(`<div class="ph"><span class="tag">${esc(currentGroup.name)}</span><h2>Привет, ${esc(student.display_name)}!</h2><p>Сегодня тренируемся на тексте «${esc(currentLesson.title)}».</p></div><div class="tp-sec"><b>Твоё задание</b><div class="preview">${esc(currentLesson.content)}</div><p class="sub">У тебя будет 10 минут. Печатай внимательно и не торопись ошибаться!</p></div><div class="row"><button class="btn ghost" id="backNames">← Это не я</button><button class="btn good glow" id="beginTyping">Начать 10 минут!</button></div>`);
  $('backNames').onclick=()=>chooseGroup(currentGroup);
  $('beginTyping').onclick=startTyping;
}

function startTyping(){
  remaining=600;startedAt=Date.now();resultSaved=false;mistakeCount=0;
  const target=currentLesson.content;
  setPanel(`<div class="timerline"><div class="ph"><span class="tag">${esc(currentGroup.name)} · ${esc(currentStudent.display_name)}</span><h2>${esc(currentLesson.title)}</h2><p class="sub">Печатай текст в поле ниже. Ошибки можно исправлять клавишей Backspace.</p></div><div class="timerchip run" id="timerChip"><i class="dot"></i><span id="timerText">10:00</span></div></div><div class="tp-sec"><div class="sub">ТЕКСТ ДЛЯ ПЕЧАТИ</div><div class="preview" style="max-height:180px">${esc(target)}</div></div><div class="stats"><span class="stat">Скорость <b id="liveSpeed">0</b> зн./мин</span><span class="stat">Ошибки <b id="liveErrors">0</b></span><span class="stat">Точность <b id="liveAccuracy">100%</b></span></div><div class="meter"><i id="progressMeter"></i></div><textarea class="type-input" id="typingInput" placeholder="Начинай печатать здесь…" spellcheck="false" autocapitalize="off" autocomplete="off"></textarea><div class="row"><span class="helper">Время идёт, даже если ты делаешь паузу.</span><button class="btn good" id="finishTyping">Завершить занятие</button></div>`);
  const input=$('typingInput');input.focus();
  input.addEventListener('beforeinput', (event) => {
    if (!event.inputType || !event.inputType.startsWith('insert')) return;
    let inserted = event.data;
    if (inserted == null && event.inputType === 'insertFromPaste') inserted = (event.clipboardData || window.clipboardData)?.getData('text') || '';
    if (inserted == null) return;
    const pos = input.selectionStart || 0;
    for (let i=0;i<inserted.length;i++) if (target[pos+i] !== inserted[i]) mistakeCount++;
  });
  input.addEventListener('input',updateLiveStats);
  $('finishTyping').onclick=()=>finishTyping(false);
  timerHandle=setInterval(()=>{remaining=Math.max(0,600-Math.floor((Date.now()-startedAt)/1000));$('timerText').textContent=fmtTime(remaining);const chip=$('timerChip');chip.className='timerchip '+(remaining<=60?'danger':remaining<=180?'warn':'run');if(remaining===0)finishTyping(true);},250);
}

function measure(){
  const target=currentLesson.content;const typed=$('typingInput')?.value||'';let correct=0,errors=0;
  for(let i=0;i<typed.length;i++){if(i<target.length&&typed[i]===target[i])correct++;else errors++;}
  errors = Math.max(errors, mistakeCount);
  const elapsed=Math.max(1,Math.min(600,Math.floor((Date.now()-startedAt)/1000)));
  const speed=Math.round(correct/(elapsed/60));const accuracy=(correct+errors)?Math.round(correct/(correct+errors)*100):100;
  return {typed,correct,errors,elapsed,speed,accuracy};
}
function updateLiveStats(){const m=measure();$('liveSpeed').textContent=m.speed;$('liveErrors').textContent=m.errors;$('liveAccuracy').textContent=m.accuracy+'%';$('progressMeter').style.width=Math.min(100,m.correct/Math.max(1,currentLesson.content.length)*100)+'%';}
async function finishTyping(timeUp){
  if(resultSaved)return;resultSaved=true;if(timerHandle)clearInterval(timerHandle);
  const m=measure();
  const payload={p_group_id:currentGroup.id,p_student_id:currentStudent.id,p_lesson_id:currentLesson.id,p_duration_seconds:m.elapsed,p_typed_chars:m.typed.length,p_correct_chars:m.correct,p_errors:m.errors,p_wpm:m.speed,p_accuracy:m.accuracy};
  const {error}=await supabase.rpc('submit_typing_result',payload);
  if(error){setPanel(`<div class="ph"><span class="tag">Результат</span><h2>Занятие завершено!</h2><p>Не получилось сохранить результат: ${esc(error.message)}</p></div><div class="metric-grid"><div class="metric"><b>${m.speed}</b><span>знаков в минуту</span></div><div class="metric"><b>${m.errors}</b><span>ошибок</span></div><div class="metric"><b>${m.accuracy}%</b><span>точность</span></div></div><button class="btn" id="homeBtn">На главную</button>`);$('homeBtn').onclick=loadGroups;return;}
  setPanel(`<div class="ph"><span class="tag">${timeUp?'Время вышло':'Занятие завершено'}</span><h2>Отличная работа, ${esc(currentStudent.display_name)}!</h2><p>Результат сохранён. В следующий раз попробуем стать ещё быстрее и точнее.</p></div><div class="metric-grid"><div class="metric"><b>${m.speed}</b><span>знаков в минуту</span></div><div class="metric"><b>${m.errors}</b><span>ошибок</span></div><div class="metric"><b>${m.accuracy}%</b><span>точность</span></div><div class="metric"><b>${fmtTime(m.elapsed)}</b><span>время работы</span></div></div><div class="row"><button class="btn good" id="homeBtn">Готово!</button></div>`,'var(--tw-mint)');$('homeBtn').onclick=loadGroups;
}

// Кабинет педагога
$('teacherBtn').addEventListener('click',()=>{teacherOverlay.hidden=false;renderTeacher();});
$('closeTeacher').addEventListener('click',()=>teacherOverlay.hidden=true);
teacherOverlay.addEventListener('click',e=>{if(e.target===teacherOverlay)teacherOverlay.hidden=true;});
$('soundBtn').addEventListener('click',()=>{soundOn=!soundOn;$('soundBtn').setAttribute('aria-pressed',String(soundOn));$('soundBtn').querySelector('span').textContent=soundOn?'Звук включён':'Звук выключен';});

async function renderTeacher(){
  if(!supabase){teacherContent.innerHTML='<div class="alert">Сначала подключите Supabase в config.js.</div>';return;}
  if(!teacherUser){teacherContent.innerHTML=`<div class="tp-gate"><p class="tp-note">Войдите, чтобы управлять своей группой</p><label class="lab" for="teacherEmail">Электронная почта</label><input class="fld" id="teacherEmail" type="email" autocomplete="username" placeholder="name@example.com"><label class="lab" for="teacherPassword">Пароль</label><input class="fld" id="teacherPassword" type="password" autocomplete="current-password" placeholder="Пароль"><button class="btn grape" id="loginBtn">Войти в кабинет</button><p class="tp-note" id="loginMessage">Учётные записи педагогов создаются администратором проекта.</p></div>`;$('loginBtn').onclick=login;return;}
  await refreshTeacherGroup();
  if(!teacherGroup){teacherContent.innerHTML=`<div class="tp-sec"><h3>Создать свою группу</h3><p class="sub">У каждого педагога отдельная группа и собственная статистика.</p><label class="lab" for="newGroupName">Название группы</label><input class="fld" id="newGroupName" placeholder="Например, Робототехника · группа 1"><button class="btn grape" id="createGroup">Создать группу</button><p class="tp-note" id="groupMessage"></p></div><button class="btn ghost small" id="logoutBtn">Выйти</button>`;$('createGroup').onclick=createGroup;$('logoutBtn').onclick=logout;return;}
  await renderTeacherDashboard();
}
async function login(){const email=$('teacherEmail').value.trim(),password=$('teacherPassword').value;showMsg('loginMessage','Проверяем данные…');const {error}=await supabase.auth.signInWithPassword({email,password});if(error){showMsg('loginMessage',error.message,true);return;}const {data:{user}}=await supabase.auth.getUser();teacherUser=user;await renderTeacher();}
async function logout(){await supabase.auth.signOut();teacherUser=null;teacherGroup=null;renderTeacher();}
async function refreshTeacherGroup(){if(!teacherUser)return;const {data,error}=await supabase.from('teacher_groups').select('*').eq('teacher_id',teacherUser.id).maybeSingle();teacherGroup=error?null:data;}
async function createGroup(){const name=$('newGroupName').value.trim();if(!name){showMsg('groupMessage','Введи название группы.',true);return;}const {data,error}=await supabase.from('teacher_groups').insert({teacher_id:teacherUser.id,name}).select().single();if(error){showMsg('groupMessage',error.message,true);return;}teacherGroup=data;await renderTeacher();}

async function renderTeacherDashboard(){
  const group=teacherGroup;
  const [{data:students,error:sErr},{data:lessons,error:lErr},{data:results,error:rErr}]=await Promise.all([
    supabase.from('students').select('*').eq('group_id',group.id).order('display_name'),
    supabase.from('lessons').select('*').eq('group_id',group.id).order('created_at',{ascending:false}),
    supabase.from('typing_results').select('*').eq('group_id',group.id).order('created_at',{ascending:false}).limit(500)
  ]);
  if(sErr||lErr||rErr){teacherContent.innerHTML=`<div class="alert">Ошибка загрузки данных: ${esc(sErr?.message||lErr?.message||rErr?.message)}</div>`;return;}
  const active=lessons.find(x=>x.is_active);
  teacherContent.innerHTML=`<div class="tp-sec"><div class="tp-head"><div><h3>${esc(group.name)}</h3><p class="sub">Данные видны только вам</p></div><button class="mini-btn" id="logoutBtn">Выйти</button></div><div class="teacher-tabs"><button data-tab="students" class="${teacherTab==='students'?'active':''}">Ученики</button><button data-tab="lesson" class="${teacherTab==='lesson'?'active':''}">Текст занятия</button><button data-tab="stats" class="${teacherTab==='stats'?'active':''}">Статистика</button></div></div><div id="teacherTabBody"></div>`;
  $('logoutBtn').onclick=logout;
  teacherContent.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>{teacherTab=b.dataset.tab;renderTeacherDashboard();});
  const body=$('teacherTabBody');
  if(teacherTab==='students')renderStudentsTab(body,students||[]);
  if(teacherTab==='lesson')renderLessonTab(body,active,lessons||[]);
  if(teacherTab==='stats')renderStatsTab(body,students||[],lessons||[],results||[]);
}
function renderStudentsTab(body,students){
 body.innerHTML=`<div class="tp-sec"><h3>Список учеников</h3><p class="sub">Добавляйте детей по имени и фамилии. Ученики выбирают себя из списка.</p><div class="tp-row"><input class="fld" id="studentName" style="flex:1;min-width:180px" placeholder="Имя и фамилия"><button class="btn grape small" id="addStudent">Добавить</button></div><p class="tp-note" id="studentMessage"></p><div class="teacher-list">${students.length?students.map(s=>`<div class="teacher-row"><strong>${esc(s.display_name)}</strong><span class="tp-row">${s.active?`<button class="mini-btn" data-edit="${s.id}">Изменить</button><button class="mini-btn danger" data-remove="${s.id}">Убрать</button>`:'<span class="tp-chip">Неактивен</span>'}</span></div>`).join(''):'<p class="tp-empty">Пока никого нет. Добавьте первого ученика.</p>'}</div></div>`;
 $('addStudent').onclick=async()=>{const name=$('studentName').value.trim();if(!name){showMsg('studentMessage','Введите имя ученика.',true);return;}const {error}=await supabase.from('students').insert({group_id:teacherGroup.id,display_name:name});if(error){showMsg('studentMessage',error.message,true);return;}renderTeacherDashboard();};
 body.querySelectorAll('[data-edit]').forEach(b=>b.onclick=async()=>{const row=students.find(s=>s.id===b.dataset.edit);const name=prompt('Изменить имя ученика:',row?.display_name||'');if(name===null)return;if(!name.trim()){alert('Имя не может быть пустым.');return;}const {error}=await supabase.from('students').update({display_name:name.trim()}).eq('id',b.dataset.edit);if(error)alert(error.message);else renderTeacherDashboard();});
 body.querySelectorAll('[data-remove]').forEach(b=>b.onclick=async()=>{if(!confirm('Убрать ученика из списка? Его история занятий сохранится.'))return;const {error}=await supabase.from('students').update({active:false}).eq('id',b.dataset.remove);if(error)alert(error.message);else renderTeacherDashboard();});
}
function renderLessonTab(body,active,lessons){
 body.innerHTML=`<div class="tp-sec"><h3>Опубликовать текст</h3><p class="sub">Вставьте любой текст. Он сразу станет доступен ученикам вашей группы.</p><div class="teacher-field"><label class="lab" for="lessonTitle">Название занятия</label><input id="lessonTitle" placeholder="Например, Удивительный космос" value=""></div><div class="teacher-field"><label class="lab" for="lessonText">Текст для печати</label><textarea id="lessonText" placeholder="Вставьте сюда текст для тренировки…"></textarea><label class="lab" for="lessonFile">Или загрузите текстовый файл (.txt)</label><input id="lessonFile" type="file" accept=".txt,text/plain"></div><p class="tp-note" id="lessonMessage"></p><button class="btn grape" id="publishLesson">Опубликовать для группы</button></div><div class="tp-sec"><h3>Текущий текст</h3>${active?`<p><b>${esc(active.title)}</b></p><div class="preview">${esc(active.content)}</div>`:'<p class="tp-empty">Пока нет опубликованного текста.</p>'}</div><div class="tp-sec"><h3>История публикаций</h3><div class="teacher-list">${lessons.length?lessons.map(l=>`<div class="teacher-row"><div><strong>${esc(l.title)}</strong><div class="helper">${fmtDate(l.created_at)} · ${l.is_active?'Сейчас опубликован':'В архиве'}</div></div>${l.is_active?'<span class="tp-chip">Активный</span>':''}</div>`).join(''):'<p class="tp-empty">История пока пуста.</p>'}</div></div>`;
 $('lessonFile').addEventListener('change',async()=>{const file=$('lessonFile').files?.[0];if(!file)return;if(file.size>200000){showMsg('lessonMessage','Файл слишком большой. Максимум 200 КБ.',true);return;}const text=await file.text();$('lessonText').value=text;if(!$('lessonTitle').value.trim())$('lessonTitle').value=file.name.replace(/\.txt$/i,'');showMsg('lessonMessage',`Загружен файл: ${file.name}`);});
 $('publishLesson').onclick=async()=>{const title=$('lessonTitle').value.trim(),content=$('lessonText').value.trim();if(!title||!content){showMsg('lessonMessage','Заполните название и текст.',true);return;}const {error}=await supabase.rpc('teacher_publish_lesson',{p_group_id:teacherGroup.id,p_title:title,p_content:content});if(error){showMsg('lessonMessage',error.message,true);return;}teacherTab='lesson';renderTeacherDashboard();};
}
function renderStatsTab(body,students,lessons,results){
 const activeStudents=students.filter(s=>s.active);const total=results.length;const avgSpeed=total?Math.round(results.reduce((a,r)=>a+Number(r.wpm||0),0)/total):0;const avgErrors=total?Math.round(results.reduce((a,r)=>a+Number(r.errors||0),0)/total*10)/10:0;
 const options=activeStudents.map(s=>`<option value="${s.id}">${esc(s.display_name)}</option>`).join('');
 body.innerHTML=`<div class="tp-sec"><h3>Общая статистика</h3><div class="metric-grid"><div class="metric"><b>${activeStudents.length}</b><span>учеников в группе</span></div><div class="metric"><b>${total}</b><span>пройдено занятий</span></div><div class="metric"><b>${avgSpeed}</b><span>средняя скорость</span></div><div class="metric"><b>${avgErrors}</b><span>ошибок за занятие</span></div></div></div><div class="tp-sec"><h3>Прогресс ученика</h3><label class="lab" for="statsStudent">Выберите ученика</label><select class="fld" id="statsStudent" style="font-size:18px">${options||'<option>Нет учеников</option>'}</select><div id="studentProgress"></div></div><div class="tp-sec"><h3>Последние результаты группы</h3><div class="table-wrap"><table class="data-table"><thead><tr><th>Дата</th><th>Ученик</th><th>Занятие</th><th>Зн./мин</th><th>Ошибки</th><th>Точность</th></tr></thead><tbody>${results.slice(0,30).map(r=>{const st=students.find(s=>s.id===r.student_id),le=lessons.find(l=>l.id===r.lesson_id);return `<tr><td>${fmtDate(r.created_at)}</td><td>${esc(st?.display_name||'Ученик')}</td><td>${esc(le?.title||'Занятие')}</td><td>${r.wpm}</td><td>${r.errors}</td><td>${r.accuracy}%</td></tr>`;}).join('')||'<tr><td colspan="6">Результатов пока нет.</td></tr>'}</tbody></table></div></div>`;
 const select=$('statsStudent');const draw=()=>{const id=select.value;const rows=results.filter(r=>r.student_id===id).sort((a,b)=>new Date(a.created_at)-new Date(b.created_at));const box=$('studentProgress');if(!rows.length){box.innerHTML='<p class="tp-empty">У этого ученика пока нет результатов.</p>';return;}const max=Math.max(1,...rows.map(r=>Number(r.wpm||0)));box.innerHTML=`<div class="metric-grid"><div class="metric"><b>${rows.length}</b><span>занятий пройдено</span></div><div class="metric"><b>${rows[rows.length-1].wpm}</b><span>последняя скорость</span></div><div class="metric"><b>${rows[rows.length-1].errors}</b><span>ошибок в последний раз</span></div></div><h4 style="font-weight:700;margin:16px 0 8px">Скорость печати, зн./мин</h4><div class="barlist">${rows.map((r,i)=>`<div class="barrow"><span class="helper">Занятие ${i+1}</span><div class="bartrack"><div class="barfill" style="width:${Math.max(2,Number(r.wpm||0)/max*100)}%"></div></div><b>${r.wpm}</b></div>`).join('')}</div><h4 style="font-weight:700;margin:16px 0 8px">Ошибки по занятиям</h4><div class="barlist">${rows.map((r,i)=>`<div class="barrow"><span class="helper">Занятие ${i+1}</span><div class="bartrack"><div class="barfill errorbar" style="width:${Math.max(2,Number(r.errors||0)/Math.max(1,...rows.map(x=>Number(x.errors||0)))*100)}%"></div></div><b>${r.errors}</b></div>`).join('')}</div>`;};select.addEventListener('change',draw);draw();
}

init();
