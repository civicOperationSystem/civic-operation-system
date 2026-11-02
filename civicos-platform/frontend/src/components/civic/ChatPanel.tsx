'use client';
import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { civicApi, Session, Member, displayDate } from '@/lib/civic';
import styles from './civic.module.css';

type Channel = { id: string; name: string; description: string; created_at: string };
type Direct = { id: string; member_id: string; member_email: string; member_name: string; last_message: string | null; updated_at: string | null };
type ChatMessage = { id: string; sender_id: string; sender_email: string; sender_name: string; body: string; created_at: string };
type Conversation = { type: 'channel'; id: string } | { type: 'direct'; id: string };
const messagesPath = (conversation: Conversation) =>
  `/staff/chat/${conversation.type === 'channel' ? 'channels' : 'direct'}/${encodeURIComponent(conversation.id)}/messages`;

export default function ChatPanel({ token, session }: { token: string; session: Session }) {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [directs, setDirects] = useState<Direct[]>([]);
  const [contacts, setContacts] = useState<Member[]>([]);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [channelName, setChannelName] = useState('');
  const [description, setDescription] = useState('');
  const [contactSearch, setContactSearch] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const bottom = useRef<HTMLLIElement>(null);
  const cursor = useRef<ChatMessage | null>(null);
  const loadLists = useCallback(async () => {
    const [availableChannels, directConversations, availableContacts] = await Promise.all([
      civicApi<Channel[]>('/staff/chat/channels', { token }),
      civicApi<Direct[]>('/staff/chat/direct', { token }),
      civicApi<Member[]>('/staff/chat/contacts', { token }),
    ]);
    setChannels(availableChannels);
    setDirects(directConversations);
    setContacts(availableContacts);
    setConversation(current => current || (availableChannels[0] ? { type: 'channel', id: availableChannels[0].id } : null));
  }, [token]);
  useEffect(() => {
    let active = true;
    void loadLists().catch(failure => {
      if (active) setError(failure instanceof Error ? failure.message : 'Could not load chats');
    });
    const interval = window.setInterval(() => {
      if (active && !document.hidden) void loadLists().catch(failure => {
        if (active) setError(failure instanceof Error ? failure.message : 'Could not refresh chats');
      });
    }, 10000);
    return () => { active = false; window.clearInterval(interval); };
  }, [loadLists]);
  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    setMessages([]);
    cursor.current = null;
    if (!conversation) return () => { active = false; };
    const refresh = async (initial: boolean) => {
      try {
        const currentCursor = cursor.current;
        const query = !initial && currentCursor
          ? `?after=${encodeURIComponent(currentCursor.created_at)}&after_id=${encodeURIComponent(currentCursor.id)}` : '';
        const incoming = await civicApi<ChatMessage[]>(`${messagesPath(conversation)}${query}`, { token });
        if (!active) return;
        if (initial) setMessages(incoming);
        else if (incoming.length) setMessages(current => [...current, ...incoming.filter(message => !current.some(item => item.id === message.id))]);
        if (incoming.length) cursor.current = incoming.at(-1)!;
        setError('');
      } catch (failure) {
        if (active) setError(failure instanceof Error ? failure.message : 'Could not load messages');
      } finally {
        if (active) timer = window.setTimeout(() => {
          if (!document.hidden) void refresh(false);
          else timer = window.setTimeout(() => { if (active) void refresh(false); }, 2000);
        }, initial ? 2500 : 2500);
      }
    };
    void refresh(true);
    return () => { active = false; if (timer !== undefined) window.clearTimeout(timer); };
  }, [conversation?.type, conversation?.id, token]);
  useEffect(() => { bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [messages]);
  async function createChannel(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const channel = await civicApi<Channel>('/staff/chat/channels', {
        token, method: 'POST', body: { name: channelName, description },
      });
      setChannelName(''); setDescription('');
      await loadLists(); setConversation({ type: 'channel', id: channel.id });
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not create channel'); }
    finally { setBusy(false); }
  }
  async function openDirect(member: Member) {
    setBusy(true); setError('');
    try {
      const direct = await civicApi<{ id: string }>('/staff/chat/direct', {
        token, method: 'POST', body: { member_id: member.id },
      });
      await loadLists(); setConversation({ type: 'direct', id: direct.id });
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not open private conversation'); }
    finally { setBusy(false); }
  }
  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!conversation || !draft.trim()) return;
    setBusy(true); setError('');
    try {
      const message = await civicApi<ChatMessage>(messagesPath(conversation), {
        token, method: 'POST', body: { body: draft },
      });
      cursor.current = message;
      setMessages(current => current.some(item => item.id === message.id) ? current : [...current, message]);
      setDraft('');
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not send message'); }
    finally { setBusy(false); }
  }
  const activeChannel = conversation?.type === 'channel' ? channels.find(item => item.id === conversation.id) : null;
  const activeDirect = conversation?.type === 'direct' ? directs.find(item => item.id === conversation.id) : null;
  const matchingContacts = contacts.filter(member =>
    `${member.display_name} ${member.email} ${member.role}`.toLowerCase().includes(contactSearch.trim().toLowerCase()));
  return <section className={styles.chatLayout} aria-label="Organization chat">
    <aside className={styles.chatSidebar}>
      <h3>Organization channels</h3>
      <div className={styles.chatNavigation}>{channels.map(channel =>
        <button key={channel.id} aria-current={conversation?.type === 'channel' && conversation.id === channel.id ? 'page' : undefined}
          onClick={() => setConversation({ type: 'channel', id: channel.id })}># {channel.name}</button>)}</div>
      <details className={styles.createChannel}>
        <summary>Create channel</summary>
        <form className={styles.form} onSubmit={createChannel}>
          <label>Channel name<input required minLength={1} maxLength={40} pattern="[a-zA-Z0-9][a-zA-Z0-9-]*" value={channelName} onChange={event => setChannelName(event.target.value)} placeholder="street-maintenance" /></label>
          <label>Description<input maxLength={240} value={description} onChange={event => setDescription(event.target.value)} /></label>
          <button className={styles.secondary} disabled={busy}>Create channel</button>
        </form>
      </details>
      <h3>Private messages</h3>
      <div className={styles.chatNavigation}>{directs.map(direct =>
        <button key={direct.id} aria-current={conversation?.type === 'direct' && conversation.id === direct.id ? 'page' : undefined}
          onClick={() => setConversation({ type: 'direct', id: direct.id })}>↗ {direct.member_name}<small>{direct.last_message || 'Start a private conversation'}</small></button>)}</div>
      <label className={styles.chatContact}>Find a teammate by name<input value={contactSearch} onChange={event => setContactSearch(event.target.value)} placeholder="Search a name" />
      <select value="" disabled={busy} onChange={event => {
        const member = contacts.find(item => item.id === event.target.value);
        if (member) void openDirect(member);
      }}><option value="">Choose a teammate…</option>{matchingContacts.map(member =>
        <option key={member.id} value={member.id}>{member.display_name} · {member.role}</option>)}</select></label>
    </aside>
    <div className={styles.chatConversation}>
      <header className={styles.chatHeader}>
        <div><h3>{activeChannel ? `# ${activeChannel.name}` : activeDirect?.member_name || 'Choose a conversation'}</h3>
          <p>{activeChannel?.description || (activeDirect ? 'Private conversation — visible only to you and this teammate.' : `${session.portal.name} staff messages`)}</p></div>
        <small>Updates every few seconds</small>
      </header>
      {error && <p role="alert" className={styles.error}>{error}</p>}
      <ol className={styles.chatMessages} aria-label="Chat messages" aria-live="polite">
        {messages.map(message => <li key={message.id} className={message.sender_id === session.user.id ? styles.ownMessage : ''}>
          <div className={styles.messageMeta}><strong>{message.sender_id === session.user.id ? 'You' : message.sender_name}</strong><time dateTime={message.created_at}>{displayDate(message.created_at, session.portal.settings)}</time></div>
          <p>{message.body}</p>
        </li>)}
        {conversation && !messages.length && <li className={styles.chatEmpty}>This conversation is ready. Send a message to get started.</li>}
        <li ref={bottom} aria-hidden="true" />
      </ol>
      <form className={styles.chatComposer} onSubmit={sendMessage}>
        <label className={styles.srOnly} htmlFor="civic-chat-message">Write a message</label>
        <textarea id="civic-chat-message" rows={2} maxLength={4000} value={draft} disabled={!conversation || busy}
          onChange={event => setDraft(event.target.value)} placeholder={conversation ? 'Write a message…' : 'Choose a channel or teammate.'} />
        <button className={styles.primary} disabled={!conversation || busy || !draft.trim()}>Send</button>
      </form>
    </div>
  </section>;
}
