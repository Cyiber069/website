// Public surface of the knowledge base. Implemented in this folder.
import type { Env } from '../types';

/** Store a fact the owner taught the agent while answering an urgent question. Returns the kb_docs id. */
export async function addLearnedFact(_env: Env, _fact: { title: string; content: string; urgent_id: string }): Promise<string | null> {
  return null;
}
