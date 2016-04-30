import express = require('express');
import path = require('path');

var port: number = process.env.PORT || 3000;
var app = express();

/************************************************
 * Path constants
 */
const PROJ_ROOT: string = path.resolve(__dirname, '..');
const PUBLIC_ROOT: string = path.resolve(PROJ_ROOT, 'public');
const CLIENT_ROOT: string = path.resolve(PROJ_ROOT, 'client');
const SERVER_ROOT: string = path.resolve(PROJ_ROOT, 'server');


/************************************************
 * Setup statics routes
 */
// Path to npm packages
app.use('/lib', express.static(path.resolve(PROJ_ROOT, 'node_modules')));

// Path to client code
app.use('/app', express.static(path.resolve(CLIENT_ROOT, 'app')));

// Path to public files
app.use('/public', express.static(PUBLIC_ROOT))


/************************************************
 * Route to index
 */
app.get('/', (req: express.Request, res: express.Response) => {
    res.sendFile(path.resolve(PUBLIC_ROOT, 'views/index.html'));
});

var server = app.listen(port, () => {
    var host = server.address().address;
    var port = server.address().port;
    console.log('This express app is listening on port:' + port);
});
