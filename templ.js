const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const { TranscribeStreamingClient, StartStreamTranscriptionCommand } = require('@aws-sdk/client-transcribe-streaming');
const { PollyClient, SynthesizeSpeechCommand } = require('@aws-sdk/client-polly');
const Groq = require('groq-sdk'); 
require('dotenv').config({ path: path.resolve(__dirname, './.env') });

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Initialize Groq client
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

const transcribeClient = new TranscribeStreamingClient({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
});

const pollyClient = new PollyClient({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
});

// NLP processing with Groq API
async function processWithGroq(transcript) {
    try {
        const completion = await groq.chat.completions.create({
            messages: [
                { role: 'system', content: 'You are a helpful assistant. Keep responses clear and concise under 2800 characters' },
                { role: 'user', content: transcript }
            ],
            model: 'llama-3.3-70b-versatile'
        });
        return completion.choices[0].message.content;
    } catch (error) {
        console.error('Groq API error:', error);
        return 'Sorry, I couldn’t process that. Please try again.';
    }
}

io.on('connection', (socket) => {
    console.log('A user connected');

    let audioStream;
    let isTranscribing = false;
    let lastProcessedTranscript = '';

    async function startTranscription() {
        if (!isTranscribing) {
            console.log('Starting transcription');
            isTranscribing = true;
            let buffer = Buffer.from('');

            audioStream = async function* () {
                while (isTranscribing) {
                    const chunk = await new Promise(resolve => socket.once('audioData', resolve));
                    if (chunk === null) break;
                    buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
                    while (buffer.length >= 1024) {
                        yield { AudioEvent: { AudioChunk: buffer.slice(0, 1024) } };
                        buffer = buffer.slice(1024);
                    }
                }
            };

            const command = new StartStreamTranscriptionCommand({
                LanguageCode: 'en-US',
                MediaSampleRateHertz: 44100,
                MediaEncoding: 'pcm',
                AudioStream: audioStream()
            });

            try {
                const response = await transcribeClient.send(command);
                console.log('Transcription started');

                for await (const event of response.TranscriptResultStream) {
                    if (!isTranscribing) break;
                    if (event.TranscriptEvent) {
                        const results = event.TranscriptEvent.Transcript.Results;
                        if (results.length > 0 && results[0].Alternatives.length > 0) {
                            const transcript = results[0].Alternatives[0].Transcript;
                            const isFinal = !results[0].IsPartial;

                            if (isFinal && transcript !== lastProcessedTranscript) {
                                console.log('Final transcription:', transcript);
                                socket.emit('transcription', { text: transcript, isFinal: true });
                                await handleFinalTranscript(transcript);
                                lastProcessedTranscript = transcript;
                            } else if (!isFinal) {
                                const newPart = transcript.substring(transcript.lastIndexOf(' ') + 1);
                                if (newPart.trim() !== '') {
                                    socket.emit('transcription', { text: newPart, isFinal: false });
                                }
                            }
                        }
                    }
                }
            } catch (error) {
                console.error('Transcription error:', error);
                socket.emit('error', 'Transcription error: ' + error.message);
            }
        }
    }

    async function handleFinalTranscript(transcript) {
        if (transcript.trim() === '') return;

        try {
            isTranscribing = false; // Pause transcription during response
            const responseText = await processWithGroq(transcript);
            console.log('Groq response:', responseText);

            const command = new SynthesizeSpeechCommand({
                Text: responseText,
                OutputFormat: 'mp3',
                VoiceId: 'Joanna',
                SampleRate: '16000',
                LanguageCode: 'en-US'
            });

            const response = await pollyClient.send(command);
            const audioStream = response.AudioStream;

            const audioChunks = [];
            for await (const chunk of audioStream) {
                audioChunks.push(chunk);
            }
            const audioBuffer = Buffer.concat(audioChunks);
            socket.emit('audioResponse', audioBuffer);
            console.log('Sent audio response to client');
        } catch (error) {
            console.error('Error in processing or synthesis:', error);
            socket.emit('error', 'Processing error: ' + error.message);
        }
    }

    socket.on('startTranscription', () => {
        startTranscription();
    });

    socket.on('audioData', (data) => {
        if (isTranscribing) {
            socket.emit('audioData', data);
        }
    });

    socket.on('stopTranscription', () => {
        console.log('Stopping transcription');
        isTranscribing = false;
        audioStream = null;
    });

    socket.on('playbackFinished', () => {
        console.log('Playback finished, restarting transcription');
        startTranscription();
    });

    socket.on('disconnect', () => {
        console.log('User disconnected');
        isTranscribing = false;
        audioStream = null;
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});