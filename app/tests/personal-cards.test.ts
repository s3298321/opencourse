// @vitest-environment node
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { installCourseFixture } from './helpers/course'
import { validateFlashcards } from '../src/core/personal-cards'
const root=mkdtempSync(join(tmpdir(),'personal-cards-test-'))
let dir=root,n=0
vi.mock('electron',() => ({app:{getPath:()=>dir,on:()=>{}},dialog:{}}))
const {db,closeDb}=await import('../src/main/db')
const {createUser,switchUser}=await import('../src/main/users')
const {reloadCourses}=await import('../src/main/courses')
const {insertChat,deleteChatRow}=await import('../src/main/chatdb')
const {createWritingNotebook,writingNotebookDirectory}=await import('../src/main/writing-notebooks')
const {createFlashcardPreview,decideFlashcardProposal,listFlashcardProposals,listPersonalCards,deletePersonalCard,targetForChat,flashcardTools,personalCardAvailability}=await import('../src/main/personal-cards')
const {getReviewSummary,startReviewSession,revealReviewAnswer,rateReviewCard,endAllReviews,resetFlashcardProgress}=await import('../src/main/review')
const {readDocument}=await import('../src/main/course-store')
const {personalCard,putPersonalCard}=await import('../src/main/personal-card-store')
const servers=await import('../src/main/servers')
beforeEach(()=>{closeDb();endAllReviews();dir=join(root,String(++n));createUser('Learner');reloadCourses()})
afterAll(()=>{closeDb();rmSync(root,{recursive:true,force:true})})
function courseChat() {
  const course=installCourseFixture({schema_version:'1.4',slug:'cards',title:'Cards',modules:[{slug:'m',title:'M',lessons:[{slug:'l',title:'L',blocks:[],flashcards:[{id:'default',question:'Default?',answer:'Default answer'}]}]}]})
  const chat=randomUUID(),lesson=course.modules[0].lessons![0]
  insertChat({id:chat,courseId:course.courseId,model:'gpt-4.1-mini',reasoning:null,startedIn:{moduleId:course.modules[0].slug,lessonId:lesson.slug},at:new Date().toISOString()})
  return {course,chat,target:{kind:'course' as const,id:course.courseId}}
}
const args={cards:[{question:'What is a closure?',answer:'A function with access to its lexical environment.'}]}
function preview(chat:string) { const result=JSON.parse(createFlashcardPreview('chat',chat,1,'call-1',args));return result.proposalId as string }
describe('personal flashcards',()=>{
  it('validates the complete bounded batch and rejects destination injection',()=>{
    expect(()=>validateFlashcards({...args,target:{kind:'course',id:'foreign'}})).toThrow('arguments')
    expect(()=>validateFlashcards({cards:[...args.cards,{question:' ',answer:'x'}]})).toThrow('Each card')
    expect(()=>validateFlashcards({cards:Array(21).fill(args.cards[0])})).toThrow('20')
    expect(()=>validateFlashcards({cards:[{question:'q',answer:'x'.repeat(8001)}]})).toThrow('8,000')
  })
  it('persists previews, saves once, stays outside manifests and survives chat deletion',()=>{
    const {course,chat,target}=courseChat(),before=JSON.stringify(readDocument(course.courseId)),id=preview(chat)
    expect(preview(chat)).toBe(id)
    expect(listPersonalCards(target)).toEqual([])
    closeDb();expect(listFlashcardProposals(chat)[0].status).toBe('pending')
    const first=decideFlashcardProposal(id,'save')
    expect(decideFlashcardProposal(id,'save')).toEqual(first)
    expect(listPersonalCards(target)).toHaveLength(1)
    expect(JSON.stringify(readDocument(course.courseId))).toBe(before)
    deleteChatRow(chat)
    expect(listFlashcardProposals(chat)).toEqual([])
    expect(listPersonalCards(target)).toHaveLength(1)
  })
  it('dismisses without creating cards and rolls back an incomplete batch',()=>{
    const {chat,target}=courseChat(),id=preview(chat)
    expect(decideFlashcardProposal(id,'dismiss').status).toBe('dismissed')
    expect(decideFlashcardProposal(id,'save').status).toBe('dismissed')
    const batch=JSON.parse(createFlashcardPreview('chat',chat,2,'batch',{cards:[...args.cards,{question:'Second?',answer:'Second.'}]})).proposalId
    db().exec("CREATE TRIGGER fail_personal BEFORE INSERT ON personal_cards WHEN new.question='Second?' BEGIN SELECT RAISE(ABORT,'disk failure'); END;")
    expect(()=>decideFlashcardProposal(batch,'save')).toThrow('disk failure')
    expect(listPersonalCards(target)).toEqual([])
    expect(listFlashcardProposals(chat)[1].status).toBe('pending')
  })
  it('unlocks personal cards immediately, hides answers and shares FSRS without unlocking authored cards',()=>{
    const {chat,target}=courseChat();decideFlashcardProposal(preview(chat),'save')
    const now=new Date('2026-11-01T10:00:00Z'),session=startReviewSession(target,10,1,now)
    expect(session.summary).toMatchObject({defaultCount:1,personalCount:1,total:2,eligible:1})
    expect(session.card?.source).toBe('personal')
    expect(JSON.stringify(session)).not.toContain(args.cards[0].answer)
    expect(()=>rateReviewCard(session.id,session.card!.id,'good',1,now)).toThrow('Reveal')
    expect(revealReviewAnswer(session.id,session.card!.id,1,now).answer).toBe(args.cards[0].answer)
    const rated=rateReviewCard(session.id,session.card!.id,'good',1,now)
    expect(rated.summary.practiced).toBe(1)
    expect(rateReviewCard(session.id,session.card!.id,'good',1,now)).toEqual(rated)
    expect(db().prepare('SELECT count(*) n FROM flashcard_states').get()?.n).toBe(0)
  })
  it('rejects competing ratings and deletion during review, and never resurrects a tombstone',()=>{
    const {chat,target}=courseChat();decideFlashcardProposal(preview(chat),'save')
    const a=startReviewSession(target,10,1),b=startReviewSession(target,10,2),id=a.card!.id
    revealReviewAnswer(a.id,id,1);revealReviewAnswer(b.id,id,2);rateReviewCard(a.id,id,'good',1)
    expect(()=>rateReviewCard(b.id,id,'good',2)).toThrow('another window')
    const c=startReviewSession(target,10,3),saved=personalCard(db(),'',target,id)!
    deletePersonalCard(target,id)
    expect(()=>revealReviewAnswer(c.id,id,3)).toThrow('deleted')
    putPersonalCard(db(),'',saved)
    expect(listPersonalCards(target)).toEqual([])
    expect(db().prepare('SELECT count(*) n FROM personal_card_reviews').get()?.n).toBe(0)
  })
  it('resets a personal schedule without deleting content and rejects updates to queued cards',()=>{
    const {chat,target}=courseChat()
    const id=JSON.parse(createFlashcardPreview('chat',chat,1,'batch',{cards:[...args.cards,{question:'Second?',answer:'Second answer'}]})).proposalId
    decideFlashcardProposal(id,'save')
    const first=startReviewSession(target,10,1),other=startReviewSession(target,10,2)
    revealReviewAnswer(other.id,other.card!.id,2)
    const next=rateReviewCard(other.id,other.card!.id,'good',2)
    revealReviewAnswer(next.id,next.card!.id,2)
    rateReviewCard(next.id,next.card!.id,'good',2)
    expect(()=>revealReviewAnswer(first.id,first.card!.id,1)).toThrow('another window')
    resetFlashcardProgress(target,first.card!.id)
    expect(listPersonalCards(target)).toHaveLength(2)
    expect(getReviewSummary(target)).toMatchObject({personalCount:2,practiced:1,new:1})
  })
  it('isolates users and independent imports',()=>{
    const {chat,target}=courseChat();const id=preview(chat);decideFlashcardProposal(id,'save')
    const other=courseChat();expect(listPersonalCards(other.target)).toEqual([])
    const uid=createUser('Other').id
    expect(()=>decideFlashcardProposal(id,'save')).toThrow('no longer available')
    expect(()=>listPersonalCards(target)).toThrow('no longer available')
    switchUser(uid)
  })
  it('gates server creation by capability and enrollment while local content stays available',()=>{
    const {chat,target}=courseChat()
    expect(flashcardTools('chat',chat)).toHaveLength(1)
    db().prepare('INSERT INTO learning_bindings(server_id,account_id,connection_id,kind,remote_id,local_id,version,state) VALUES(?,?,?,?,?,?,?,?)')
      .run('server','account','connection','course',randomUUID(),target.id,'1.0.0',JSON.stringify({enrollment:{active:true}}))
    const connection={id:'connection',url:'https://example.test',name:'Test server',token:'test',account:{id:'account',username:'learner',email:'learner@example.test'}}
    const access=vi.spyOn(servers,'serverAccess').mockReturnValue({...connection,capabilities:[]})
    try {
      expect(flashcardTools('chat',chat)).toEqual([])
      expect(personalCardAvailability(target)).toContain('server needs')
      access.mockReturnValue({...connection,capabilities:['personal-flashcards-v1']})
      expect(flashcardTools('chat',chat)).toHaveLength(1)
      db().prepare('UPDATE learning_bindings SET state=? WHERE local_id=?').run(JSON.stringify({enrollment:{active:false}}),target.id)
      expect(()=>preview(chat)).toThrow('My learning again')
      db().prepare('DELETE FROM learning_bindings WHERE local_id=?').run(target.id)
      expect(flashcardTools('chat',chat)).toHaveLength(1)
    } finally { access.mockRestore() }
  })
  it('routes notebooks and documents and rejects a changed writing-notebook association',()=>{
    const {course,chat,target}=courseChat()
    expect(targetForChat('chat',chat)).toEqual(target)
    const projectChat=randomUUID()
    db().prepare("INSERT INTO course_project_chats(id,course_slug,module_slug,model,created_at,updated_at) VALUES(?,?,?,'gpt-4.1-mini','','')").run(projectChat,course.courseId,course.modules[0].slug)
    expect(targetForChat('project',projectChat)).toEqual(target)
    expect(flashcardTools('project',projectChat)).toHaveLength(1)
    const doc=randomUUID()
    db().prepare("INSERT INTO documents(id,title,bytes,fingerprint,status,created_at) VALUES(?,'PDF',1,?,'ready',?)").run(doc,randomUUID(),new Date().toISOString())
    const docChat=randomUUID()
    db().prepare("INSERT INTO document_chats(id,document_id,started_on,model,provider,created_at,updated_at) VALUES(?,?,1,'gpt-4.1-mini','apiKey','','')").run(docChat,doc)
    const p=JSON.parse(createFlashcardPreview('document',docChat,1,'doc',args)).proposalId
    decideFlashcardProposal(p,'save')
    expect(getReviewSummary({kind:'document',id:doc})).toMatchObject({defaultCount:0,personalCount:1,eligible:1})
    const session=startReviewSession({kind:'document',id:doc},10,1);revealReviewAnswer(session.id,session.card!.id,1);rateReviewCard(session.id,session.card!.id,'good',1)
    db().prepare('UPDATE documents SET fingerprint=? WHERE id=?').run(randomUUID(),doc)
    expect(getReviewSummary({kind:'document',id:doc}).practiced).toBe(1)
    const notebook=createWritingNotebook('Notes',{kind:'course',id:course.courseId,title:'Cards'}),nc=randomUUID()
    db().prepare("INSERT INTO writing_notebook_chats(id,notebook_id,started_on,model,provider,created_at,updated_at) VALUES(?,?,?,'gpt-4.1-mini','apiKey','','')").run(nc,notebook.id,notebook.selectedPageId)
    const np=JSON.parse(createFlashcardPreview('writing-notebook',nc,1,'n',args)).proposalId
    const file=join(writingNotebookDirectory(notebook.id),'notebook.json'),stored=JSON.parse(readFileSync(file,'utf8'))
    stored.association={kind:'document',id:doc,title:'PDF'};writeFileSync(file,JSON.stringify(stored))
    expect(()=>decideFlashcardProposal(np,'save')).toThrow('association')
    delete stored.association;writeFileSync(file,JSON.stringify(stored))
    expect(flashcardTools('writing-notebook',nc)).toEqual([])
    expect(listFlashcardProposals(nc)).toHaveLength(1)
    expect(()=>createFlashcardPreview('writing-notebook',nc,2,'n2',args)).toThrow('Link this notebook')
  })
})
