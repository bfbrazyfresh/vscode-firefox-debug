import { Log } from '../../util/log';
import { EventEmitter } from 'events';
import { DebugConnection } from '../connection';
import { PendingRequest, PendingRequests } from './pendingRequests';
import { ActorProxy } from './interface';
import { PauseActorProxy } from './pause';
import { SourceActorProxy } from './source';

class QueuedRequest<T> {
	send: () => void;
	resolve: (t: T) => void;
	reject: (err: any) => void;
}

/**
 * A ThreadActorProxy is a proxy for a "thread-like actor" (a Tab or a WebWorker) in Firefox. 
 * The ThreadActor is attached immediately and there is no support to detach and re-attach it, 
 * so unless the thread is exited, the ThreadActor will be either in the running or paused state.
 */
export class ThreadActorProxy extends EventEmitter implements ActorProxy {

	/**
	 * desiredState determines the state that the thread should "gravitate towards". 
	 * It may be put in a different state temporarily to set and remove breakpoints or execute 
	 * a clientEvaluate request, but once these operations have finished, it will be interrupted 
	 * if desiredState is 'paused' or resumed (with a corresponding resumeLimit if desiredState
	 * is not 'running') otherwise.
	 */
	private desiredState: string = 'paused'; // 'paused' | 'running' | 'stepOver' | stepInto' | 'stepOut'
	
	/**
	 * The paused flag states if the thread is assumed to be in the paused or the 
	 * running state.
	 */
	private paused: boolean = true;
	
	/**
	 * The number of operations that are currently running which require the thread to be 
	 * paused (even if desiredState is not 'paused'). These operations are started using 
	 * runOnPausedThread() and if the thread is running it will automatically be paused 
	 * temporarily.
	 */
	private operationsRunningOnPausedThread = 0;

	/**
	 * frame requests can only be run on a paused thread and they can only be sent
	 * when pauseWanted is set to true because they make no sense otherwise. 
	 */
	private pendingFrameRequests = new PendingRequests<FirefoxDebugProtocol.Frame[]>();

	/**
	 * evaluate requests can only be run on a paused thread and they can only be sent when
	 * pauseWanted is set to true because they make no sense otherwise.
	 */
	private queuedEvaluateRequests: QueuedRequest<FirefoxDebugProtocol.Grip>[] = [];
	private pendingEvaluateRequest: PendingRequest<FirefoxDebugProtocol.Grip> = null;
	
	/**
	 * Use this constructor to create a ThreadActorProxy. It will be attached immediately.
	 */
	constructor(private _name: string, private connection: DebugConnection) {
		super();
		this.connection.register(this);
		this.connection.sendRequest({ to: this.name, type: 'attach' });
		this.connection.sendRequest({ to: this.name, type: 'sources' });
		Log.debug(`Created and attached thread ${this.name}`);
	}

	public get name() {
		return this._name;
	}

	private sendPauseRequest(): void {

		Log.debug(`Sending pause request to thread ${this.name}`);

		this.connection.sendRequest({ to: this.name, type: 'interrupt' });
		this.paused = true;
	}
	
	/**
	 * Run a (possibly asynchronous) operation on the paused thread.
	 * If the thread is not already paused, it will be paused temporarily and automatically 
	 * resumed when the operation is finished (if there are no other reasons to pause the 
	 * thread). The operation is passed a callback that must be called when it is finished.
	 */
	public runOnPausedThread<T>(operation: (finished: () => void) => (T | Thenable<T>)): Promise<T> {

		Log.debug('Starting operation on paused thread');
		this.operationsRunningOnPausedThread++;
		
		return new Promise<T>((resolve) => {
			
			if (!this.paused) {
				this.sendPauseRequest();
			}

			var result = operation(() => this.operationFinishedOnPausedThread());
			resolve(result);
		});
	}
	
	/**
	 * This method is called when an operation started with runOnPausedThread finishes.
	 */
	private operationFinishedOnPausedThread() {

		Log.debug('Operation finished on paused thread');
		this.operationsRunningOnPausedThread--;
		
		this.doNext();
	}

	/**
	 * Figure out what to do next after an operation started with runOnPausedThread has
	 * finished, an evaluateRequest has been enqueued or has finished or the desiredState
	 * has changed.
	 */
	private doNext() {

		if (this.operationsRunningOnPausedThread > 0) {
			
			if (!this.paused) {
				Log.error('The thread isn\'t paused but an operation that requires the thread to be paused is still running!');
			}
			
		} else {

			if (this.pendingEvaluateRequest != null) {
				
				if (this.paused) {
					this.connection.sendRequest({ to: this.name, type: 'resume' });
					this.paused = false;
				}
			
			} else if (this.queuedEvaluateRequests.length > 0) {

				if (this.paused) {

					let queuedEvaluateRequest = this.queuedEvaluateRequests.shift();
					this.pendingEvaluateRequest = { resolve: queuedEvaluateRequest.resolve, reject: queuedEvaluateRequest.reject };
					queuedEvaluateRequest.send();
					this.paused = false;
					
				} else {
					
					Log.warn('The thread is running but an evaluate request is still queued - rejecting');
					
					this.queuedEvaluateRequests.forEach((queuedEvaluateRequest) => {
						queuedEvaluateRequest.reject('Thread is running');
					});
				}

			} else {

				switch (this.desiredState) {
					
					case 'paused':
						if (!this.paused) {
							this.sendPauseRequest();
						}
						break;
						
					case 'running':
						if (this.paused) {
							this.connection.sendRequest({ to: this.name, type: 'resume' });
							this.paused = false;
						}
						break;
						
					case 'stepOver':
						if (this.paused) {
							this.connection.sendRequest({ to: this.name, type: 'resume', resumeLimit: { type: 'next' } });
							this.paused = false;
						}
						break;
						
					case 'stepInto':
						if (this.paused) {
							this.connection.sendRequest({ to: this.name, type: 'resume', resumeLimit: { type: 'step' } });
							this.paused = false;
						}
						break;
						
					case 'stepOut':
						if (this.paused) {
							this.connection.sendRequest({ to: this.name, type: 'resume', resumeLimit: { type: 'finish' } });
							this.paused = false;
						}
						break;
				}
			}
		}
	}
	
	/**
	 * Interrupt the thread if it isn't paused already and set desiredState to 'paused'.
	 */	
	public interrupt(): void {

		Log.debug(`Want thread ${this.name} to be paused`);

		this.desiredState = 'paused';
		
		if (!this.paused) {
			this.sendPauseRequest();
		}
	}

	public fetchStackFrames(): Promise<FirefoxDebugProtocol.Frame[]> {

		if (this.desiredState != 'paused') {
			Log.warn(`fetchStackFrames() called but desiredState is ${this.desiredState}`)
			return Promise.reject('not paused');
		}
		
		Log.debug(`Fetching stackframes from thread ${this.name}`);

		return new Promise<FirefoxDebugProtocol.Frame[]>((resolve, reject) => {

			if (this.paused) {

				this.pendingFrameRequests.enqueue({ resolve, reject });
				this.connection.sendRequest({ to: this.name, type: 'frames' });

			} else {
				Log.warn('fetchStackFrames() called but thread is running')
				reject('not paused');
			}
			
		});
	}
	
	public resume(): void {

		if (this.desiredState != 'paused') {
			Log.warn(`resume() called but desiredState is already ${this.desiredState}`);
			return;
		}
		
		Log.debug(`Resuming thread ${this.name}`);

		this.desiredState = 'running';
		this.doNext();
		
	}
	
	public stepOver(): void {

		if (this.desiredState != 'paused') {
			Log.warn(`stepOver() called but desiredState is already ${this.desiredState}`);
			return;
		}
		
		Log.debug(`Resuming thread ${this.name}`);

		this.desiredState = 'stepOver';
		this.doNext();
		
	}
	
	public stepInto(): void {

		if (this.desiredState != 'paused') {
			Log.warn(`stepInto() called but desiredState is already ${this.desiredState}`);
			return;
		}
		
		Log.debug(`Resuming thread ${this.name}`);

		this.desiredState = 'stepInto';
		this.doNext();
		
	}
	
	public stepOut(): void {

		if (this.desiredState != 'paused') {
			Log.warn(`stepOut() called but desiredState is already ${this.desiredState}`);
			return;
		}
		
		Log.debug(`Resuming thread ${this.name}`);

		this.desiredState = 'stepOut';
		this.doNext();
		
	}
	
	public evaluate(expr: string, frameActorName: string): Promise<FirefoxDebugProtocol.Grip> {

		if (this.desiredState != 'paused') {
			Log.warn(`evaluate() called but desiredState is ${this.desiredState}`);
			return Promise.reject('not paused');
		}
		
		return new Promise<FirefoxDebugProtocol.Grip>((resolve, reject) => {

			let send = () => {
				this.connection.sendRequest({ to: this.name, type: 'clientEvaluate', expression: expr, frame: frameActorName});
			};

			this.queuedEvaluateRequests.push({ send, resolve, reject });
			this.doNext();
		});
	}

	public receiveResponse(response: FirefoxDebugProtocol.Response): void {
		
		if (response['type'] === 'paused') {

			Log.debug(`Thread ${this.name} paused`);

			let pausedResponse = <FirefoxDebugProtocol.ThreadPausedResponse>response;
			
			switch (pausedResponse.why.type) {
				case 'attached':
					Log.debug('Received attached event');
					break;

				case 'interrupted':
					Log.debug('Received paused event of type interrupted');
					this.paused = true;
					// if the desiredState is not 'paused' then the thread has only been 
					// interrupted temporarily, so we don't send a 'paused' event.
					if (this.desiredState == 'paused') {
						this.emit('paused', pausedResponse.why.type);
					}
					break;
					
				case 'resumeLimit':
					Log.debug('Received paused event of type resumeLimit');
					this.paused = true;
					this.desiredState = 'paused';
					this.doNext();
					this.emit('paused', pausedResponse.why.type);
					break;
					
				case 'breakpoint':
					Log.debug('Received paused event of type breakpoint');
					this.paused = true;
					this.desiredState = 'paused';
					this.doNext();
					this.emit('paused', pausedResponse.why.type);
					break;
					
				case 'clientEvaluated':
					Log.debug('Received paused event of type clientEvaluated');
					this.paused = true;
					this.pendingEvaluateRequest.resolve(pausedResponse.why.frameFinished.return);
					this.pendingEvaluateRequest = null;
					this.doNext();
					if (this.paused) {
						this.emit('paused', pausedResponse.why.type);
					}
					break;

				case 'debuggerStatement':
				case 'watchpoint':
				case 'pauseOnDOMEvents':
					Log.error(`Paused event with reason ${pausedResponse.why.type} not handled yet`);
					break;
			}

		} else if (response['type'] === 'resumed') {

			Log.debug(`Received resumed event from ${this.name} (ignoring)`);
			
		} else if (response['type'] === 'newSource') {
			
			let source = <FirefoxDebugProtocol.Source>(response['source']);

			Log.debug(`New source ${source.url} on thread ${this.name}`);

			let sourceActor = this.connection.getOrCreate(source.actor, 
				() => new SourceActorProxy(source, this.connection));
			this.emit('newSource', sourceActor);
			
		} else if (response['sources']) {

			let sources = <FirefoxDebugProtocol.Source[]>(response['sources']);

			Log.debug(`Received ${sources.length} sources from thread ${this.name}`);

		} else if (response['frames']) {

			let frames = <FirefoxDebugProtocol.Frame[]>(response['frames']);

			Log.debug(`Received ${frames.length} frames from thread ${this.name}`);

			this.pendingFrameRequests.resolveOne(frames);
			
		} else if (response['type'] === 'detached') {
			
			Log.debug(`Thread ${this.name} detached`);
			
		} else if (response['type'] === 'exited') {
			
			Log.debug(`Thread ${this.name} exited`);

			this.pendingFrameRequests.rejectAll('Exited');
			
			this.emit('exited');
			//TODO send release packet(?)
			
		} else if (response['error'] === 'wrongState') {

			Log.warn(`Thread ${this.name} was in the wrong state for the last request`);

			//TODO reject last request!
			
			this.emit('wrongState');
			
		} else {

			if (response['type'] === 'newGlobal') {
				Log.debug(`Received newGlobal event from ${this.name} (ignoring)`);
			} else {
				Log.warn("Unknown message from ThreadActor: " + JSON.stringify(response));
			}			

		}
			
	}
	
	public onPaused(cb: (why: string) => void) {
		this.on('paused', cb);
	}

	public onExited(cb: () => void) {
		this.on('exited', cb);
	}

	public onWrongState(cb: () => void) {
		this.on('wrongState', cb);
	}

	public onNewSource(cb: (newSource: SourceActorProxy) => void) {
		this.on('newSource', cb);
	}
}
