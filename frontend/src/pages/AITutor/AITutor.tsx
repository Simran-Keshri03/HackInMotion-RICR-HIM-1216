import { type FormEvent, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Failed, Loading } from '@/components/Loading/States';
import { useApi } from '@/hooks/useApi';
import { api } from '@/lib/api';
import type { ConversationSummary, TutorMessage, TutorReply } from '@/types/api';

/**
 * The doubt-solving tutor.
 *
 * What makes it worth having over a general chatbot is the context the backend attaches: the
 * learner's mastery on the topic in view and the questions they recently got wrong. A learner at
 * mastery 20 gets the basic idea first; a learner at 80 does not get told what the topic is.
 *
 * Arriving from the practice screen passes `?topic=` and `?question=`, so "I don't understand
 * this" is answered about the question actually on screen instead of in the abstract.
 */
export default function AITutor() {
    const [params] = useSearchParams();
    const topicId = params.get('topic') ?? undefined;
    const aboutQuestion = params.get('question') ?? undefined;

    const history = useApi<{ conversations: ConversationSummary[] }>(() =>
        api.get<{ conversations: ConversationSummary[] }>('/ai/conversations')
    );

    const [conversationId, setConversationId] = useState<string | null>(null);
    const [messages, setMessages] = useState<TutorMessage[]>([]);
    const [question, setQuestion] = useState('');
    const [asking, setAsking] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Keep the newest message in view as the exchange grows.
    const endRef = useRef<HTMLDivElement | null>(null);
    useEffect(() => {
        endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }, [messages.length, asking]);

    async function ask(text: string) {
        const trimmed = text.trim();
        if (trimmed === '' || asking) return;

        setError(null);
        setAsking(true);

        // Show the learner's own message straight away. Waiting for the round trip to echo it back
        // makes the app feel like it dropped what they typed.
        setMessages((current) => [
            ...current,
            { role: 'learner', content: trimmed, createdAt: new Date().toISOString() },
        ]);
        setQuestion('');

        try {
            const reply = await api.post<TutorReply>('/ai/tutor', {
                question: trimmed,
                ...(conversationId
                    ? { conversationId }
                    : {
                          // Only sent on the first message; afterwards the conversation carries
                          // its own topic, so a follow-up stays grounded without resending it.
                          ...(topicId ? { topicId } : {}),
                          ...(aboutQuestion ? { currentQuestion: aboutQuestion } : {}),
                      }),
            });

            setConversationId(reply.conversationId);
            setMessages((current) => [
                ...current,
                {
                    role: 'tutor',
                    content: reply.answer,
                    createdAt: new Date().toISOString(),
                },
            ]);

            // The thread now exists, or has moved to the top of the list.
            history.reload();
        } catch (cause) {
            setError(
                cause instanceof Error
                    ? cause.message
                    : 'Could not reach the tutor. Your question was saved — try again.'
            );
        } finally {
            setAsking(false);
        }
    }

    async function openThread(id: string) {
        setError(null);
        setConversationId(id);
        setMessages([]);

        try {
            const thread = await api.get<{ messages: TutorMessage[] }>(
                `/ai/conversations/${id}`
            );
            setMessages(thread.messages);
        } catch (cause) {
            setError(
                cause instanceof Error ? cause.message : 'Could not open that conversation.'
            );
        }
    }

    function startNew() {
        setConversationId(null);
        setMessages([]);
        setError(null);
    }

    return (
        <div className="stack">
            <div className="spread">
                <div>
                    <span className="label">Ask Adigam</span>
                    <h1>Stuck on something?</h1>
                </div>
                {messages.length > 0 && (
                    <button type="button" onClick={startNew}>
                        New question
                    </button>
                )}
            </div>

            {aboutQuestion && messages.length === 0 && (
                <div className="banner">
                    <span className="label">About this question</span>
                    <p style={{ margin: '6px 0 0' }}>{aboutQuestion}</p>
                </div>
            )}

            {messages.length === 0 && (
                <p className="muted" style={{ margin: 0 }}>
                    Ask anything about what you are studying. Answers use what you have
                    already practised, so they start where you actually are.
                </p>
            )}

            {/* ------------------------------------------------ the exchange */}
            {messages.length > 0 && (
                <div className="stack" style={{ gap: 12 }}>
                    {messages.map((message, index) => (
                        <div
                            key={`${message.createdAt}-${index}`}
                            className={
                                message.role === 'learner'
                                    ? 'card card--accent'
                                    : 'card'
                            }
                        >
                            <span className="label">
                                {message.role === 'learner' ? 'You' : 'Adigam'}
                            </span>
                            {/* Paragraphs preserved: the tutor is told to write short paragraphs
                                separated by blank lines, and collapsing them into one block would
                                undo the readability that was asked for. */}
                            {message.content
                                .split(/\n{2,}/)
                                .filter((part) => part.trim() !== '')
                                .map((paragraph, i) => (
                                    <p
                                        key={i}
                                        style={{
                                            marginTop: i === 0 ? 8 : 12,
                                            marginBottom: 0,
                                            whiteSpace: 'pre-wrap',
                                        }}
                                    >
                                        {paragraph}
                                    </p>
                                ))}
                        </div>
                    ))}

                    {asking && <Loading label="Thinking…" />}
                    <div ref={endRef} />
                </div>
            )}

            {error && <div className="banner banner--error">{error}</div>}

            {/* ------------------------------------------------ input */}
            <form
                className="card stack"
                onSubmit={(event: FormEvent) => {
                    event.preventDefault();
                    void ask(question);
                }}
            >
                <div className="field">
                    <label htmlFor="question">
                        {messages.length > 0 ? 'Ask a follow-up' : 'Your question'}
                    </label>
                    <input
                        id="question"
                        value={question}
                        maxLength={2000}
                        placeholder="Why does this formula work?"
                        disabled={asking}
                        onChange={(e) => setQuestion(e.target.value)}
                    />
                </div>

                <button
                    type="submit"
                    className="primary wide"
                    disabled={asking || question.trim() === ''}
                >
                    {asking ? 'Asking…' : 'Ask'}
                </button>
            </form>

            {/* ------------------------------------------------ history */}
            {history.loading && <Loading label="Loading your questions…" />}
            {history.error ? (
                <Failed error={history.error} onRetry={history.reload} />
            ) : null}

            {(history.data?.conversations.length ?? 0) > 0 && (
                <div className="card stack" style={{ gap: 8 }}>
                    <span className="label">Your questions</span>

                    {history.data?.conversations.map((thread) => (
                        <button
                            key={thread.id}
                            type="button"
                            className="option"
                            aria-pressed={thread.id === conversationId}
                            onClick={() => void openThread(thread.id)}
                        >
                            <span className="option__mark">
                                {thread.answered ? '' : '·'}
                            </span>
                            <span>
                                {thread.title}
                                {!thread.answered && (
                                    <span className="faint"> — not answered yet</span>
                                )}
                            </span>
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}
