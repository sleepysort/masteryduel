import $ from 'jquery';

const MESSAGE_LOGGER_SELECTOR = '.message-logger-content';

export class MessageLogger {
	public static systemMessage(msg: string): void {
		let logger = $(MESSAGE_LOGGER_SELECTOR);
		if (logger.length !== 0) {
			logger.append('<p class="system-message">' + msg + '</p>');
		}
	}

	public static playerChatMessage(msg: string): void {
		let logger = $(MESSAGE_LOGGER_SELECTOR);
		if (logger.length !== 0) {
			logger.append('<p class="player-message">You: ' + msg + '</p>');
		}
	}

	public static opponentChatMessage(msg: string): void {
		let logger = $(MESSAGE_LOGGER_SELECTOR);
		if (logger.length !== 0) {
			logger.append('<p class="player-message">Opponent: ' + msg + '</p>');
		}
	}

	public static scrollToBottom(): void {
		let logger = $(MESSAGE_LOGGER_SELECTOR);
		if (logger.length !== 0) {
			logger.scrollTop(logger.innerHeight());
		}
	}
}
