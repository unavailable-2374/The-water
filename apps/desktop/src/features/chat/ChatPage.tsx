import { AssistantPanel } from '@/assistant/AssistantPanel';
/** The full-page and studio surfaces subscribe to the same durable assistant. */
export function ChatPage() {
 return <div className="mx-auto h-full max-w-4xl"><AssistantPanel/></div>;
}
