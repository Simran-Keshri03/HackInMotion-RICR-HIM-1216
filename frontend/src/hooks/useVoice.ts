import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Asking a question out loud, and hearing the answer.
 *
 * Both halves are built into the browser — `SpeechRecognition` for listening, `speechSynthesis` for
 * speaking — so this adds nothing to the bundle and costs nothing per use. That matters here more
 * than it usually would: the app has to run on phones with 2-4 GB of RAM, and a speech library would
 * have been larger than the entire rest of the frontend. It also means no audio ever leaves the
 * device except as the text the tutor was already going to receive.
 *
 * Neither API is uniformly available, and both fail in ways that are invisible if you do not look:
 *
 * - `SpeechRecognition` is Chrome, Edge and Safari, behind a `webkit` prefix on most of them.
 *   Firefox does not have it at all. So support is reported rather than assumed, and the caller
 *   hides the microphone instead of showing a button that does nothing.
 * - Recognition needs microphone permission, and a refusal arrives as an error event rather than a
 *   rejected promise.
 * - Chrome truncates long utterances, which for a tutor's multi-paragraph explanation means the
 *   voice stops mid-answer with no error. Text is spoken in sentence-sized pieces to avoid it.
 * - Neither stops on its own when the page navigates away. Without cleanup, a learner leaving the
 *   tutor mid-answer keeps hearing it on the dashboard.
 */

/**
 * The parts of the Web Speech API this uses.
 *
 * Declared here rather than pulled in as a dependency: the DOM lib does not include
 * SpeechRecognition, and the six fields below are the whole surface actually touched.
 */
interface SpeechRecognitionLike {
    lang: string;
    continuous: boolean;
    interimResults: boolean;
    start(): void;
    stop(): void;
    abort(): void;
    onresult: ((event: SpeechRecognitionEventLike) => void) | null;
    onerror: ((event: { error: string }) => void) | null;
    onend: (() => void) | null;
}

interface SpeechRecognitionEventLike {
    results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>;
}

type RecognitionConstructor = new () => SpeechRecognitionLike;

function recognitionConstructor(): RecognitionConstructor | null {
    if (typeof window === 'undefined') return null;

    const holder = window as unknown as {
        SpeechRecognition?: RecognitionConstructor;
        webkitSpeechRecognition?: RecognitionConstructor;
    };

    return holder.SpeechRecognition ?? holder.webkitSpeechRecognition ?? null;
}

/**
 * Indian English, because that is who uses this.
 *
 * The difference is not cosmetic: `en-US` recognition mishears Indian-accented English often enough
 * to make voice input more annoying than typing, which is the same as not having the feature.
 */
const LANG = 'en-IN';

/** Longest chunk handed to the speech engine at once, to stay clear of Chrome's truncation. */
const MAX_UTTERANCE_CHARS = 180;

/**
 * Splits text into pieces the speech engine will reliably finish.
 *
 * Sentence boundaries first, because a break mid-sentence is audible. A sentence longer than the
 * limit is split on a word boundary rather than cut, which is rare but happens with long formulae.
 */
export function toUtterances(text: string): string[] {
    const sentences = text
        .replace(/\s+/g, ' ')
        .split(/(?<=[.!?])\s+/)
        .map((part) => part.trim())
        .filter((part) => part !== '');

    const chunks: string[] = [];

    for (const sentence of sentences) {
        if (sentence.length <= MAX_UTTERANCE_CHARS) {
            chunks.push(sentence);
            continue;
        }

        let rest = sentence;

        while (rest.length > MAX_UTTERANCE_CHARS) {
            const window = rest.slice(0, MAX_UTTERANCE_CHARS);
            const cut = window.lastIndexOf(' ');
            const at = cut > MAX_UTTERANCE_CHARS / 2 ? cut : MAX_UTTERANCE_CHARS;

            chunks.push(rest.slice(0, at).trim());
            rest = rest.slice(at).trim();
        }

        if (rest !== '') chunks.push(rest);
    }

    return chunks;
}

export interface Voice {
    /** True when this browser can listen. False on Firefox, so the caller hides the microphone. */
    canListen: boolean;
    /** True when this browser can speak. */
    canSpeak: boolean;
    listening: boolean;
    speaking: boolean;
    /** What was heard so far, including the not-yet-final part, so the learner sees it as they talk. */
    heard: string;
    /** Set when the microphone was refused or recognition failed. Cleared on the next attempt. */
    error: string | null;
    /** Starts listening. `onFinal` fires once with the finished transcript. */
    listen: (onFinal: (transcript: string) => void) => void;
    stopListening: () => void;
    speak: (text: string) => void;
    stopSpeaking: () => void;
}

export function useVoice(): Voice {
    const [listening, setListening] = useState(false);
    const [speaking, setSpeaking] = useState(false);
    const [heard, setHeard] = useState('');
    const [error, setError] = useState<string | null>(null);

    const recognition = useRef<SpeechRecognitionLike | null>(null);

    const canListen = recognitionConstructor() !== null;
    const canSpeak = typeof window !== 'undefined' && typeof window.speechSynthesis !== 'undefined';

    const stopListening = useCallback(() => {
        recognition.current?.stop();
        recognition.current = null;
        setListening(false);
    }, []);

    const stopSpeaking = useCallback(() => {
        if (canSpeak) window.speechSynthesis.cancel();
        setSpeaking(false);
    }, [canSpeak]);

    /**
     * Both are stopped when the component goes away.
     *
     * Not defensive tidiness — neither API is tied to the React tree, so without this a learner who
     * navigates away mid-answer keeps hearing the tutor on the next screen, and the microphone stays
     * live with its indicator on.
     */
    useEffect(() => {
        return () => {
            recognition.current?.abort();
            recognition.current = null;
            if (typeof window !== 'undefined' && window.speechSynthesis) {
                window.speechSynthesis.cancel();
            }
        };
    }, []);

    const listen = useCallback(
        (onFinal: (transcript: string) => void) => {
            const Recognition = recognitionConstructor();
            if (!Recognition || listening) return;

            // Listening while speaking makes the tutor's own voice part of the question.
            stopSpeaking();

            setError(null);
            setHeard('');

            const instance = new Recognition();
            instance.lang = LANG;
            instance.continuous = false;
            // Interim results so the learner can see they are being heard. Without them the screen
            // is silent for several seconds and people assume it is broken and start again.
            instance.interimResults = true;

            let finalText = '';

            instance.onresult = (event) => {
                let interim = '';

                for (let i = 0; i < event.results.length; i += 1) {
                    const result = event.results[i]!;
                    const transcript = result[0]?.transcript ?? '';

                    if (result.isFinal) finalText += transcript;
                    else interim += transcript;
                }

                setHeard((finalText + interim).trim());
            };

            instance.onerror = (event) => {
                setError(
                    event.error === 'not-allowed' || event.error === 'service-not-allowed'
                        ? 'Microphone access was blocked. Allow it in your browser to ask by voice.'
                        : event.error === 'no-speech'
                          ? 'Did not catch that. Try again.'
                          : 'Could not hear you. You can type instead.'
                );
                setListening(false);
                recognition.current = null;
            };

            instance.onend = () => {
                setListening(false);
                recognition.current = null;

                const said = finalText.trim();
                if (said !== '') onFinal(said);
            };

            recognition.current = instance;
            setListening(true);

            try {
                instance.start();
            } catch {
                // Calling start twice throws synchronously. Nothing useful to tell the learner.
                setListening(false);
                recognition.current = null;
            }
        },
        [listening, stopSpeaking]
    );

    const speak = useCallback(
        (text: string) => {
            if (!canSpeak || text.trim() === '') return;

            window.speechSynthesis.cancel();

            const chunks = toUtterances(text);
            if (chunks.length === 0) return;

            setSpeaking(true);

            chunks.forEach((chunk, index) => {
                const utterance = new SpeechSynthesisUtterance(chunk);
                utterance.lang = LANG;

                // A voice matching the language if the device has one; otherwise the default, which
                // is still understandable. getVoices() is empty until the list loads, so a missing
                // match is normal rather than a problem.
                const match = window.speechSynthesis
                    .getVoices()
                    .find((voice) => voice.lang === LANG);

                if (match) utterance.voice = match;

                // Only the last chunk reports the end, so `speaking` follows the whole answer
                // rather than the first sentence.
                if (index === chunks.length - 1) {
                    utterance.onend = () => setSpeaking(false);
                    utterance.onerror = () => setSpeaking(false);
                }

                window.speechSynthesis.speak(utterance);
            });
        },
        [canSpeak]
    );

    return {
        canListen,
        canSpeak,
        listening,
        speaking,
        heard,
        error,
        listen,
        stopListening,
        speak,
        stopSpeaking,
    };
}
