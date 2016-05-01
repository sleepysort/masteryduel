import {Component, OnInit} from 'angular2/core';
import {Dictionary, ChampionDto} from '../../interfaces/interfaces';
import {LolApiService} from '../services/lolapi.service';
/**
 * The root component of the application.
 * @author shawn
 */

@Component({
	selector: 'md-app',
	templateUrl: 'app/templates/app.xml',
	providers: [LolApiService],
	directives: []
})


export class AppComponent implements OnInit {
	public sock: SocketIOClient.Socket;
	public sockEvent: string;
	public sockData: string;

	constructor(private lolApi: LolApiService) { }

	public ngOnInit(): void {
		this.attemptConnectSocket();
	}

	private attemptConnectSocket(): void {
		this.sock = io();

		this.sock.once('gamejoin-ack', (res: any) => {
			if (!res.success) {
				console.log('Could not connect to game: ' + res.reason);
				this.sock.close();
				return;
			}
			this.sock.on('gameprep', (msg) => {console.log(msg)});
			this.sock.on('gameselect-ack', (msg) => {console.log(msg)});
			this.sock.on('gameinit', (msg) => {console.log(msg)});
			this.sock.on('gameupdate', (msg) => {console.log(msg)});
			this.sock.on('gameerror', (msg) => {console.log(msg)});
		});

		this.sock.emit('gamejoin', this.getGameId());
	}

	private getGameId(): string {
		return window.location.pathname.substr(-12);
	}

	public sendMessage() {
		console.log('emitting');
		this.sock.emit(this.sockEvent, JSON.parse(this.sockData));
	}
}
