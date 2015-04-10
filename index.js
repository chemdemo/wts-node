/*
* @Author: dm.yang
* @Date:   2015-04-05 15:55:27
* @Last Modified by:   dm.yang
* @Last Modified time: 2015-04-10 14:48:16
*/

'use strict';

var net = require('net');
var path = require('path');
var fs = require('fs');
var pty = require('pty.js');
var ProtoBuf = require('protobufjs');
var _ = require('lodash');

var env = process.env.NODE_ENV || (process.env.NODE_ENV = 'development');
var isDev = !!(process.platform.match(/win/) || env !== 'production');

var conf = require('./conf');
var builder = ProtoBuf.loadProtoFile(path.resolve(__dirname, './socket.proto'));
var Proto = builder.build('Socket');
var Input = Proto.Input;
var Output = Proto.Output;

var monitHost = conf.monitorHost;
var monitPort = conf.monitorPort;

var client = new net.Socket();
var terms = {};
var termName = fs.existsSync('/usr/share/terminfo/x/xterm-256color')?'xterm-256color' :'xterm';

connect();

function connect() {
    client.connect(monitPort, monitHost);
};

client.on('connect', function() {
    console.log('monitor client connect to %s:%s success', monitHost, monitPort);
    client.isConnect = true;
});

client.on('timeout', function() {
    console.warn('monitor client timeout');
});

client.on('error', function(err) {
    console.error('monitor client error', err);
});

client.on('close', function() {
    client.isConnect = false;
    client.clientId = null;

    if(!client.isDestroy) {
        console.warn('monitor client closed');
        setTimeout(function() {
            console.log('try to reconnect monitor');
            connect();
        }, 1000);
    }
});

client.on('data', dataHandle);

function dataHandle(data) {
    if(isDev) console.log('\x1b[1m\x1b[32m->\x1b[m\n', data.toString());

    try {
        var msg = Input.decode(data);
    } catch(e) {
        if(e.decoded) {
            msg = e.decoded;
        } else {
            console.error('\x1b[1m\x1b[31mdecode error\x1b[m\n', e.stack);
            return;
        }
    }

    if(!msg.cmd) {
        console.warn('\x1b[1m\x1b[33mparam `cmd` missing\x1b[m');
        return;
    }

    switch(msg.cmd) {
        case 'client:ready':
            client.clientId = msg.clientId;
            send2monit({cmd: 'client:online', conf: conf.conf});
            break;

        case 'client:destroy':
            process.exit();
            break;

        case 'term:input':
            var term = getTerm(msg.termId);

            if(term) term.write(msg.input, 'utf8');
            break;

        case 'term:destroy':
            var term = getTerm(msg.termId);

            if(term) {
                delete terms[msg.termId];
                console.log('remove term:%s', msg.termId);
            }
            break;

        default: break;
    }
};

function send2monit(msg) {
    if(!msg || !Object.keys(msg).length) return;

    if(!client.isConnect) {
        console.warn('socket has not connected');
        return;
    }

    if(!client.clientId) {
        console.error('client id has not assigned');
        return;
    }

    msg.clientId = client.clientId;

    var output = new Output(msg);

    client.write(output.toBuffer());
    if(isDev) console.log('\x1b[1m\x1b[32m<-\x1b[m\n', JSON.stringify(msg));
};

function getTerm(termId) {
    if(termId in terms) return terms[termId];

    var termConf = _.assign(conf.term, {name: termName});
    var term = pty.fork(process.env.SHELL || 'sh', [], termConf);

    // client.setNoDelay(false) may not work?
    term.on('data', function(data) {
        send2monit({cmd: 'client:output', termId: termId, output: data});
    });

    terms[termId] = term;

    return term;
};
