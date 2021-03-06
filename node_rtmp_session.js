//
//  Created by Mingliang Chen on 17/8/1.
//  illuspas[a]gmail.com
//  Copyright (c) 2017 Nodemedia. All rights reserved.
//
const EventEmitter = require('events');
const QueryString = require('querystring');

const AMF = require('./node_core_amf');
const Handshake = require('./node_rtmp_handshake');
const BufferPool = require('./node_core_bufferpool');
const NodeHttpSession = require('./node_http_session');
const NodeCoreUtils = require('./node_core_utils');

const EXTENDED_TIMESTAMP_TYPE_NOT_USED = 'not-used';
const EXTENDED_TIMESTAMP_TYPE_ABSOLUTE = 'absolute';
const EXTENDED_TIMESTAMP_TYPE_DELTA = 'delta';
const TIMESTAMP_ROUNDOFF = 4294967296;

const STREAM_BEGIN = 0x00;
const STREAM_EOF = 0x01;
const STREAM_DRY = 0x02;
const STREAM_EMPTY = 0x1f;
const STREAM_READY = 0x20;

class NodeRtmpSession extends EventEmitter {
  constructor(config, socket) {
    super();
    this.config = config;
    this.bp = new BufferPool();

    this.socket = socket;
    this.players = null;

    this.inChunkSize = 128;
    this.outChunkSize = config.rtmp.chunk_size;
    this.previousChunkMessage = {};

    this.ping = config.rtmp.ping === undefined ? 60000 : config.rtmp.ping * 1000;
    this.pingTimeout = config.rtmp.ping_timeout;
    this.pingInterval = null;

    this.isStarting = false;
    this.isPublishing = false;
    this.isPlaying = false;
    this.isIdling = false;
    this.isFirstAudioReceived = false;
    this.isFirstVideoReceived = false;
    this.metaData = null;
    this.aacSequenceHeader = null;
    this.avcSequenceHeader = null;
    this.audioCodec = 0;
    this.videoCodec = 0;

    this.gopCacheEnable = config.rtmp.gop_cache;
    this.rtmpGopCacheQueue = null;
    this.flvGopCacheQueue = null;

    this.ackSize = 0;
    this.inLastAck = 0;

    this.appname = '';

    this.streams = 0;

    this.playStreamId = 0;
    this.playStreamPath = '';
    this.playArgs = '';

    this.publishStreamId = 0;
    this.publishStreamPath = '';
    this.publishArgs = '';

    this.publishNotifyTimeout = null;

    this.on('connect', this.onConnect);
    this.on('publish', this.onPublish);
    this.on('play', this.onPlay);
    this.on('closeStream', this.onCloseStream);
    this.on('deleteStream', this.onDeleteStream);

    this.socket.on('data', this.onSocketData.bind(this));
    this.socket.on('close', this.onSocketClose.bind(this));
    this.socket.on('error', this.onSocketError.bind(this));
  }

  run() {
    this.isStarting = true;
    this.bp.init(this.handleData())
  }

  stop() {
    if (this.isStarting) {
      this.isStarting = false;
      this.bp.stop();
    }
  }

  onSocketData(data) {
    this.bp.push(data);
  }

  onSocketError(e) {
    this.stop();
  }

  onSocketClose() {
    this.stop();
  }

  * handleData() {
    console.log('[rtmp handshake] start');
    if (this.bp.need(1537)) {
      if (yield) return;
    }
    let c0c1 = this.bp.read(1537);
    let s0s1s2 = Handshake.generateS0S1S2(c0c1);
    this.socket.write(s0s1s2);

    if (this.bp.need(1536)) {
      if (yield) return;
    }
    let c2 = this.bp.read(1536);
    console.log('[rtmp handshake] done');
    console.log('[rtmp message parser]  start');
    this.bp.readBytes = 0;
    while (this.isStarting) {
      let message = {};
      let chunkMessageHeader = null;
      let previousChunk = null;

      if (this.bp.need(1)) {
        if (yield) break;
      }
      let chunkBasicHeader = this.bp.read(1);
      message.formatType = chunkBasicHeader[0] >> 6;
      message.chunkStreamID = chunkBasicHeader[0] & 0x3F;
      if (message.chunkStreamID === 0) {
        // Chunk basic header 2
        if (this.bp.need(1)) {
          if (yield) break;
        }
        let exCSID = this.bp.read(1);
        message.chunkStreamID = exCSID[0] + 64;
      } else if (message.chunkStreamID === 1) {
        // Chunk basic header 3
        if (this.bp.need(2)) {
          if (yield) break;
        }
        let exCSID = this.bp.read(2);
        message.chunkStreamID = (exCSID[0] << 8) + exCSID[1] + 64;
      } else {
        // Chunk basic header 1
      }
      previousChunk = this.previousChunkMessage[message.chunkStreamID];
      if (message.formatType === 0) {
        //Type 0 (11 bytes)
        if (this.bp.need(11)) {
          if (yield) break;
        }
        chunkMessageHeader = this.bp.read(11);
        message.timestamp = chunkMessageHeader.readUIntBE(0, 3);
        if (message.timestamp === 0xffffff) {
          message.extendedTimestampType = EXTENDED_TIMESTAMP_TYPE_ABSOLUTE;
        } else {
          message.extendedTimestampType = EXTENDED_TIMESTAMP_TYPE_NOT_USED;
        }
        message.timestampDelta = 0;
        message.messageLength = chunkMessageHeader.readUIntBE(3, 3);
        message.messageTypeID = chunkMessageHeader[6];
        message.messageStreamID = chunkMessageHeader.readUInt32LE(7);
        message.receivedLength = 0;
        message.chunks = [];
      } else if (message.formatType === 1) {
        //Type 1 (7 bytes)
        if (this.bp.need(7)) {
          if (yield) break;
        }
        chunkMessageHeader = this.bp.read(7);
        message.timestampDelta = chunkMessageHeader.readUIntBE(0, 3);
        if (message.timestampDelta === 0xffffff) {
          message.extendedTimestampType = EXTENDED_TIMESTAMP_TYPE_DELTA;
        } else {
          message.extendedTimestampType = EXTENDED_TIMESTAMP_TYPE_NOT_USED;
        }
        message.messageLength = chunkMessageHeader.readUIntBE(3, 3);
        message.messageTypeID = chunkMessageHeader[6];
        if (previousChunk != null) {
          message.timestamp = previousChunk.timestamp;
          message.messageStreamID = previousChunk.messageStreamID;
          message.receivedLength = previousChunk.receivedLength;
          message.chunks = previousChunk.chunks;
        } else {
          console.error(`Chunk reference error for type ${message.formatType}: previous chunk for id ${message.chunkStreamID} is not found`);
          break;
        }
      } else if (message.formatType === 2) {
        // Type 2 (3 bytes)
        if (this.bp.need(3)) {
          if (yield) break;
        }
        chunkMessageHeader = this.bp.read(3);
        message.timestampDelta = chunkMessageHeader.readUIntBE(0, 3);
        if (message.timestampDelta === 0xffffff) {
          message.extendedTimestampType = EXTENDED_TIMESTAMP_TYPE_DELTA;
        } else {
          message.extendedTimestampType = EXTENDED_TIMESTAMP_TYPE_NOT_USED;
        }
        if (previousChunk != null) {
          message.timestamp = previousChunk.timestamp;
          message.messageStreamID = previousChunk.messageStreamID;
          message.messageLength = previousChunk.messageLength;
          message.messageTypeID = previousChunk.messageTypeID;
          message.receivedLength = previousChunk.receivedLength;
          message.chunks = previousChunk.chunks;
        } else {
          console.error(`Chunk reference error for type ${message.formatType}: previous chunk for id ${message.chunkStreamID} is not found`);
          break;
        }
      } else if (message.formatType == 3) {
        // Type 3 (0 byte)
        if (previousChunk != null) {
          message.timestamp = previousChunk.timestamp;
          message.messageStreamID = previousChunk.messageStreamID;
          message.messageLength = previousChunk.messageLength;
          message.timestampDelta = previousChunk.timestampDelta;
          message.messageTypeID = previousChunk.messageTypeID;
          message.receivedLength = previousChunk.receivedLength;
          message.chunks = previousChunk.chunks;
        } else {
          console.error(`Chunk reference error for type ${message.formatType}: previous chunk for id ${message.chunkStreamID} is not found`);
          break;
        }
      } else {
        console.error("Unknown format type: " + message.formatType);
        break;
      }

      if (message.extendedTimestampType === EXTENDED_TIMESTAMP_TYPE_ABSOLUTE) {
        if (this.bp.need(4)) {
          if (yield) break;
        }
        let extTimestamp = this.bp.read(4);
        message.timestamp = extTimestamp.readUInt32BE();
      } else if (message.extendedTimestampType === EXTENDED_TIMESTAMP_TYPE_DELTA) {
        let extTimestamp = this.bp.read(4);
        message.timestampDelta = extTimestamp.readUInt32BE();
      }

      let chunkBodySize = message.messageLength;
      chunkBodySize -= message.receivedLength;
      chunkBodySize = Math.min(chunkBodySize, this.inChunkSize);

      if (this.bp.need(chunkBodySize)) {
        if (yield) break;
      }
      let chunkBody = this.bp.read(chunkBodySize);
      message.receivedLength += chunkBodySize;
      message.chunks.push(chunkBody);
      if (message.receivedLength == message.messageLength) {
        if (message.timestampDelta != null) {
          message.timestamp += message.timestampDelta;
          if (message.timestamp > TIMESTAMP_ROUNDOFF) {
            message.timestamp %= TIMESTAMP_ROUNDOFF;
          }
        }
        let rtmpBody = Buffer.concat(message.chunks);
        this.handleRTMPMessage(message, rtmpBody);
        message.receivedLength = 0;
        message.chunks = [];
        rtmpBody = null;
      }
      this.previousChunkMessage[message.chunkStreamID] = message;

      if (this.bp.readBytes >= 0xf0000000) {
        this.bp.readBytes = 0;
        this.inLastAck = 0;
      }
      if (this.ackSize > 0 && this.bp.readBytes - this.inLastAck >= this.ackSize) {
        this.inLastAck = this.bp.readBytes;
        this.sendACK(this.bp.readBytes);
      }
    }

    console.log('[rtmp message parser] done');

    this.onCloseStream(this.playStreamId);
    this.onCloseStream(this.publishStreamId);

    if (this.pingInterval != null) {
      clearImmediate(this.pingInterval);
      this.pingInterval = null;
    }
    if (this.publishNotifyTimeout != null) {
      clearTimeout(this.publishNotifyTimeout);
      this.publishNotifyTimeout = null;
    }
    this.sessions.delete(this.id);
    this.idlePlayers = null;
    this.publishers = null;
    this.sessions = null;
    this.bp = null;
    this.socket = null;
  }

  createRtmpMessage(rtmpHeader, rtmpBody) {
    let formatTypeID = 0;
    let useExtendedTimestamp = false;
    let timestamp;
    let rtmpBodySize = rtmpBody.length;
    let rtmpBodyPos = 0;
    let chunkBodys = [];
    let type3Header = new Buffer([(3 << 6) | rtmpHeader.chunkStreamID]);

    if (rtmpHeader.chunkStreamID == null) {
      //console.warn("[rtmp] warning: createRtmpMessage(): chunkStreamID is not set for RTMP message");
    }
    if (rtmpHeader.timestamp == null) {
      //console.warn("[rtmp] warning: createRtmpMessage(): timestamp is not set for RTMP message");
    }
    if (rtmpHeader.messageTypeID == null) {
      //console.warn("[rtmp] warning: createRtmpMessage(): messageTypeID is not set for RTMP message");
    }
    if (rtmpHeader.messageStreamID == null) {
      //console.warn("[rtmp] warning: createRtmpMessage(): messageStreamID is not set for RTMP message");
    }

    if (rtmpHeader.timestamp >= 0xffffff) {
      useExtendedTimestamp = true;
      timestamp = [0xff, 0xff, 0xff];
    } else {
      timestamp = [(rtmpHeader.timestamp >> 16) & 0xff, (rtmpHeader.timestamp >> 8) & 0xff, rtmpHeader.timestamp & 0xff];
    }

    let headerBufs = new Buffer([(formatTypeID << 6) | rtmpHeader.chunkStreamID, timestamp[0], timestamp[1], timestamp[2], (rtmpBodySize >> 16) & 0xff, (rtmpBodySize >> 8) & 0xff, rtmpBodySize & 0xff, rtmpHeader.messageTypeID, rtmpHeader.messageStreamID & 0xff, (rtmpHeader.messageStreamID >>> 8) & 0xff, (rtmpHeader.messageStreamID >>> 16) & 0xff, (rtmpHeader.messageStreamID >>> 24) & 0xff]);
    if (useExtendedTimestamp) {
      let extendedTimestamp = new Buffer([(rtmpHeader.timestamp >> 24) & 0xff, (rtmpHeader.timestamp >> 16) & 0xff, (rtmpHeader.timestamp >> 8) & 0xff, rtmpHeader.timestamp & 0xff]);
      headerBufs = Buffer.concat([headerBufs, extendedTimestamp]);
    }

    chunkBodys.push(headerBufs);
    do {
      if (rtmpBodySize > this.outChunkSize) {
        chunkBodys.push(rtmpBody.slice(rtmpBodyPos, rtmpBodyPos + this.outChunkSize));
        rtmpBodySize -= this.outChunkSize
        rtmpBodyPos += this.outChunkSize;
        chunkBodys.push(type3Header);
      } else {
        chunkBodys.push(rtmpBody.slice(rtmpBodyPos, rtmpBodyPos + rtmpBodySize));
        rtmpBodySize -= rtmpBodySize;
        rtmpBodyPos += rtmpBodySize;
      }
    } while (rtmpBodySize > 0)

    return Buffer.concat(chunkBodys);
  }

  handleRTMPMessage(rtmpHeader, rtmpBody) {
    // console.log(`[rtmp handleRtmpMessage] rtmpHeader.messageTypeID=${rtmpHeader.messageTypeID}`);
    switch (rtmpHeader.messageTypeID) {
      case 1:
        this.inChunkSize = rtmpBody.readUInt32BE();
        console.log('[rtmp handleRtmpMessage] Set In chunkSize:' + this.inChunkSize);
        break;
      case 3:
        // console.log('[rtmp handleRtmpMessage] Ack:' + rtmpBody.readUInt32BE());
        break;
      case 4:
        let userControlMessage = {};
        userControlMessage.eventType = rtmpBody.readUInt16BE();
        userControlMessage.eventData = rtmpBody.slice(2);
        this.handleUserControlMessage(userControlMessage);
        break;
      case 5:
        this.ackSize = rtmpBody.readUInt32BE();
        // console.log(`[rtmp handleRtmpMessage] WindowAck: ${this.ackSize}`);
        break;
      case 8:
        //Audio Data
        this.handleAudioMessage(rtmpHeader, rtmpBody);
        break;
      case 9:
        //Video Data
        this.handleVideoMessage(rtmpHeader, rtmpBody);
        break;
      case 15:
        //AMF3 DataMessage
        let amf3Data = AMF.decodeAmf0Data(rtmpBody.slice(1));
        this.handleAMFDataMessage(rtmpHeader.messageStreamID, amf3Data);
        break;
      case 17:
        //AMF3 CommandMessage
        let amf3Cmd = AMF.decodeAmf0Cmd(rtmpBody.slice(1));
        this.handleAMFCommandMessage(rtmpHeader.messageStreamID, amf3Cmd);
        break;
      case 18:
        //AMF0 DataMessage
        let amf0Data = AMF.decodeAmf0Data(rtmpBody);
        this.handleAMFDataMessage(rtmpHeader.messageStreamID, amf0Data);
        break;
      case 20:
        //AMF0 CommandMessage
        let amf0Cmd = AMF.decodeAmf0Cmd(rtmpBody);
        this.handleAMFCommandMessage(rtmpHeader.messageStreamID, amf0Cmd);
        break;
    }
  }

  handleUserControlMessage(userControlMessage) {
    switch (userControlMessage.eventType) {
      case 3:
        let streamID = userControlMessage.eventData.readUInt32BE();
        let bufferLength = userControlMessage.eventData.readUInt32BE(4);
        console.log(`[rtmp handleUserControlMessage] SetBufferLength: streamID=${streamID} bufferLength=${bufferLength}`);
        break;
      case 7:
        let timestamp = userControlMessage.eventData.readUInt32BE();
        // console.log(`[rtmp handleUserControlMessage] PingResponse: timestamp=${timestamp}`);
        break;
    }
  }

  handleAMFDataMessage(streamID, dataMessage) {
    // console.log('handleAMFDataMessage', dataMessage);
    switch (dataMessage.cmd) {
      case '@setDataFrame':
        if (dataMessage.dataObj != null) {
          let opt = {
            cmd: 'onMetaData',
            cmdObj: dataMessage.dataObj
          };
          this.metaData = AMF.encodeAmf0Data(opt);
        }
        break;
      default:
        break;
    }
  }

  handleAMFCommandMessage(streamID, commandMessage) {
    // console.log('handleAMFCommandMessage:', commandMessage);
    switch (commandMessage.cmd) {
      case 'connect':
        this.emit('connect', commandMessage.cmdObj);
        break;
      case 'createStream':
        this.respondCreateStream(commandMessage);
        break;
      case 'FCPublish':
        // this.respondFCPublish();
        break;
      case 'publish':
        this.publishStreamPath = '/' + this.appname + '/' + commandMessage.streamName.split('?')[0];
        this.publishArgs = QueryString.parse(commandMessage.streamName.split('?')[1]);
        this.publishStreamId = streamID;
        // console.log('publish streamID=' + streamID);
        this.emit('publish');
        break;
      case 'play':
        this.playStreamPath = '/' + this.appname + '/' + commandMessage.streamName.split('?')[0];
        this.playArgs = QueryString.parse(commandMessage.streamName.split('?')[1]);
        this.playStreamId = streamID;
        // console.log('play streamID=' + streamID);
        this.emit('play');
        break;
      case 'closeStream':
        this.emit('closeStream', streamID);
        break;
      case 'deleteStream':
        this.emit('deleteStream', streamID);
        break;
      case 'pause':
        // this.pauseOrUnpauseStream();
        break;
      case 'releaseStream':
        // this.respondReleaseStream();
        break;
      case 'FCUnpublish':
        // this.respondFCUnpublish();
        break;
      default:
        console.warn("[rtmp handleCommandMessage] unknown AMF command: " + commandMessage.cmd);
        break;
    }
  }

  handleAudioMessage(rtmpHeader, rtmpBody) {
    if (!this.isPublishing) {
      return;
    }
    if (!this.isFirstAudioReceived) {
      let sound_format = rtmpBody[0];
      let sound_type = sound_format & 0x01;
      let sound_size = (sound_format >> 1) & 0x01;
      let sound_rate = (sound_format >> 2) & 0x03;
      sound_format = (sound_format >> 4) & 0x0f;
      console.log(`[rtmp handleAudioMessage] Parse AudioTagHeader sound_format=${sound_format} sound_type=${sound_type} sound_size=${sound_size} sound_rate=${sound_rate}`);
      this.audioCodec = sound_format;
      if (sound_format == 10) {
        //cache aac sequence header
        if (rtmpBody[1] == 0) {
          this.aacSequenceHeader = Buffer.from(rtmpBody);
          this.isFirstAudioReceived = true;
        }
      } else {
        this.isFirstAudioReceived = true;
      }

    }
    // console.log('Audio chunkStreamID='+rtmpHeader.chunkStreamID+' '+rtmpHeader.messageStreamID);
    // console.log(`Send Audio message timestamp=${rtmpHeader.timestamp} timestampDelta=${rtmpHeader.timestampDelta} bytesRead=${this.socket.bytesRead}`);

    let rtmpMessage = this.createRtmpMessage(rtmpHeader, rtmpBody);
    let flvMessage = NodeHttpSession.createFlvMessage(rtmpHeader, rtmpBody);
    if (this.rtmpGopCacheQueue != null) {
      if (this.aacSequenceHeader != null && rtmpBody[1] == 0) {
        //skip aac sequence header
      } else {
        this.rtmpGopCacheQueue.add(rtmpMessage);
        this.flvGopCacheQueue.add(flvMessage);
      }
    }

    for (let playerId of this.players) {
      let session = this.sessions.get(playerId);
      if (session instanceof NodeRtmpSession) {
        rtmpMessage.writeUInt32LE(session.playStreamId, 8);
        session.socket.write(rtmpMessage);
      } else if (session instanceof NodeHttpSession) {
        session.res.write(flvMessage, null, (e) => {
          //websocket will throw a error if not set the cb when closed
        });
      }
    }
  }

  handleVideoMessage(rtmpHeader, rtmpBody) {
    if (!this.isPublishing) {
      return;
    }
    let frame_type = rtmpBody[0];
    let codec_id = frame_type & 0x0f;
    frame_type = (frame_type >> 4) & 0x0f;

    if (!this.isFirstVideoReceived) {
      this.videoCodec = codec_id;
      console.log(`[rtmp handleVideoMessage] Parse VideoTagHeader frame_type=${frame_type} codec_id=${codec_id}`);

      if (codec_id == 7 || codec_id == 12) {
        //cache avc sequence header
        if (frame_type == 1 && rtmpBody[1] == 0) {
          this.avcSequenceHeader = Buffer.from(rtmpBody);
          this.isFirstVideoReceived = true;
          this.rtmpGopCacheQueue = this.gopCacheEnable ? new Set() : null;
          this.flvGopCacheQueue = this.gopCacheEnable ? new Set() : null;
        }
      } else {
        this.isFirstVideoReceived = true;
      }
    }
    // console.log('Video chunkStreamID='+rtmpHeader.chunkStreamID+' '+rtmpHeader.messageStreamID);
    // console.log(`Send Video message timestamp=${rtmpHeader.timestamp} timestampDelta=${rtmpHeader.timestampDelta} `);

    let rtmpMessage = this.createRtmpMessage(rtmpHeader, rtmpBody);
    let flvMessage = NodeHttpSession.createFlvMessage(rtmpHeader, rtmpBody);

    if ((codec_id == 7 || codec_id == 12) && this.rtmpGopCacheQueue != null) {
      if (frame_type == 1 && rtmpBody[1] == 1) {
        this.rtmpGopCacheQueue.clear();
        this.flvGopCacheQueue.clear();
      }
      if (frame_type == 1 && rtmpBody[1] == 0) {
        //skip avc sequence header
      } else {
        this.rtmpGopCacheQueue.add(rtmpMessage);
        this.flvGopCacheQueue.add(flvMessage);
      }
    }

    for (let playerId of this.players) {
      let session = this.sessions.get(playerId);
      if (session instanceof NodeRtmpSession) {
        rtmpMessage.writeUInt32LE(session.playStreamId, 8);
        session.socket.write(rtmpMessage);
      } else if (session instanceof NodeHttpSession) {
        session.res.write(flvMessage, null, (e) => {
          //websocket will throw a error if not set the cb when closed
        });
      }
    }
  }

  sendACK(size) {
    let rtmpBuffer = new Buffer('02000000000004030000000000000000', 'hex');
    rtmpBuffer.writeUInt32BE(size, 12);
    // //console.log('windowACK: '+rtmpBuffer.hex());
    this.socket.write(rtmpBuffer);
  }

  sendWindowACK(size) {
    let rtmpBuffer = new Buffer('02000000000004050000000000000000', 'hex');
    rtmpBuffer.writeUInt32BE(size, 12);
    // //console.log('windowACK: '+rtmpBuffer.hex());
    this.socket.write(rtmpBuffer);
  };

  setPeerBandwidth(size, type) {
    let rtmpBuffer = new Buffer('0200000000000506000000000000000000', 'hex');
    rtmpBuffer.writeUInt32BE(size, 12);
    rtmpBuffer[16] = type;
    // //console.log('setPeerBandwidth: '+rtmpBuffer.hex());
    this.socket.write(rtmpBuffer);
  };

  setChunkSize(size) {
    let rtmpBuffer = new Buffer('02000000000004010000000000000000', 'hex');
    rtmpBuffer.writeUInt32BE(size, 12);
    // //console.log('setChunkSize: '+rtmpBuffer.hex());
    this.socket.write(rtmpBuffer);
  };

  sendStreamStatus(st, id) {
    let rtmpBuffer = new Buffer('020000000000060400000000000000000000', 'hex');
    rtmpBuffer.writeUInt16BE(st, 12);
    rtmpBuffer.writeUInt32BE(id, 14);
    this.socket.write(rtmpBuffer);
  }

  sendRtmpSampleAccess() {
    let rtmpHeader = {
      chunkStreamID: 5,
      timestamp: 0,
      messageTypeID: 0x12,
      messageStreamID: 1
    };

    let opt = {
      cmd: '|RtmpSampleAccess',
      bool1: false,
      bool2: false
    };

    let rtmpBody = AMF.encodeAmf0Data(opt);
    let rtmpMessage = this.createRtmpMessage(rtmpHeader, rtmpBody);
    this.socket.write(rtmpMessage);
  }

  sendStatusMessage(id, level, code, description) {
    let rtmpHeader = {
      chunkStreamID: 5,
      timestamp: 0,
      messageTypeID: 0x14,
      messageStreamID: id
    };
    let opt = {
      cmd: 'onStatus',
      transId: 0,
      cmdObj: null,
      info: {
        level: level,
        code: code,
        description: description
      }
    };
    let rtmpBody = AMF.encodeAmf0Cmd(opt);
    let rtmpMessage = this.createRtmpMessage(rtmpHeader, rtmpBody);
    this.socket.write(rtmpMessage);
  }

  pingRequest() {
    let currentTimestamp = Date.now() - this.startTimestamp;
    let rtmpHeader = {
      chunkStreamID: 2,
      timestamp: currentTimestamp,
      messageTypeID: 0x4,
      messageStreamID: 0
    };
    let rtmpBody = new Buffer([0, 6, (currentTimestamp >> 24) & 0xff, (currentTimestamp >> 16) & 0xff, (currentTimestamp >> 8) & 0xff, currentTimestamp & 0xff])
    let rtmpMessage = this.createRtmpMessage(rtmpHeader, rtmpBody);
    this.socket.write(rtmpMessage);
    // console.log('pingRequest',rtmpMessage.toString('hex'));
  }

  respondConnect() {
    let rtmpHeader = {
      chunkStreamID: 3,
      timestamp: 0,
      messageTypeID: 0x14,
      messageStreamID: 0
    };
    let opt = {
      cmd: '_result',
      transId: 1,
      cmdObj: {
        fmsVer: 'FMS/3,0,1,123',
        capabilities: 31
      },
      info: {
        level: 'status',
        code: 'NetConnection.Connect.Success',
        description: 'Connection succeeded.',
        objectEncoding: this.objectEncoding
      }
    };
    let rtmpBody = AMF.encodeAmf0Cmd(opt);
    let rtmpMessage = this.createRtmpMessage(rtmpHeader, rtmpBody);
    this.socket.write(rtmpMessage);
  }

  respondCreateStream(cmd) {
    this.streams++;
    let rtmpHeader = {
      chunkStreamID: 3,
      timestamp: 0,
      messageTypeID: 0x14,
      messageStreamID: 0
    };
    let opt = {
      cmd: "_result",
      transId: cmd.transId,
      cmdObj: null,
      info: this.streams

    };
    let rtmpBody = AMF.encodeAmf0Cmd(opt);
    let rtmpMessage = this.createRtmpMessage(rtmpHeader, rtmpBody);
    this.socket.write(rtmpMessage);
  }

  respondPlay() {
    this.sendStreamStatus(STREAM_BEGIN, this.playStreamId);
    this.sendStatusMessage(this.playStreamId, 'status', 'NetStream.Play.Reset', 'Playing and resetting stream.');
    this.sendStatusMessage(this.playStreamId, 'status', 'NetStream.Play.Start', 'Started playing stream.');
    this.sendRtmpSampleAccess();
  }

  onConnect(cmdObj) {
    this.connectCmdObj = cmdObj;
    this.appname = cmdObj.app;
    this.objectEncoding = cmdObj.objectEncoding != null ? cmdObj.objectEncoding : 0;
    this.sendWindowACK(5000000);
    this.setPeerBandwidth(5000000, 2);
    this.setChunkSize(this.outChunkSize);
    this.respondConnect();
    this.startTimestamp = Date.now();
    this.pingInterval = setInterval(() => {
      this.pingRequest();
    }, this.ping);
    console.log('[rtmp connect]  app: ' + cmdObj.app);
  }

  onPublish() {
    if (this.config.auth !== undefined && this.config.auth.publish) {
      let results = NodeCoreUtils.verifyAuth(this.publishArgs.sign, this.publishStreamPath, this.config.auth.secret);
      if (!results) {
        console.log(`[rtmp publish] Unauthorized. ID=${this.id} streamPath=${this.publishStreamPath} sign=${this.publishArgs.sign}`);
        this.sendStatusMessage(this.publishStreamId, 'error', 'NetStream.publish.Unauthorized', 'Authorization required.');
        return;
      }
    }

    if (this.publishers.has(this.publishStreamPath)) {
      console.warn("[rtmp publish] Already has a stream path " + this.publishStreamPath);
      this.sendStatusMessage(this.publishStreamId, 'error', 'NetStream.Publish.BadName', 'Stream already publishing');
    } else if (this.isPublishing) {
      console.warn("[rtmp publish] NetConnection is publishing ");
      this.sendStatusMessage(this.publishStreamId, 'error', 'NetStream.Publish.BadConnection', 'Connection already publishing');
    } else {
      console.log("[rtmp publish] new stream path " + this.publishStreamPath + ' streamId:' + this.publishStreamId);
      this.publishers.set(this.publishStreamPath, this.id);
      this.isPublishing = true;
      this.players = new Set();
      this.sendStatusMessage(this.publishStreamId, 'status', 'NetStream.Publish.Start', `${this.publishStreamPath} is now published.`);
      this.publishNotifyTimeout = setTimeout(() => {
        for (let idlePlayerId of this.idlePlayers) {
          let idlePlayer = this.sessions.get(idlePlayerId);
          if (idlePlayer.playStreamPath === this.publishStreamPath) {
            idlePlayer.emit('play');
            this.idlePlayers.delete(idlePlayerId);
          }
        }
      }, 100);
    }
  }

  onPlay() {
    if (this.config.auth !== undefined && this.config.auth.play) {
      let results = NodeCoreUtils.verifyAuth(this.playArgs.sign, this.playStreamPath, this.config.auth.secret);
      if (!results) {
        console.log(`[rtmp play] Unauthorized. ID=${this.id} streamPath=${this.playStreamPath} sign=${this.playArgs.sign}`);
        this.sendStatusMessage(this.playStreamId, 'error', 'NetStream.play.Unauthorized', 'Authorization required.');
        return;
      }
    }

    if (this.isPlaying) {
      console.warn("[rtmp play] NetConnection is playing");
      this.sendStatusMessage(this.playStreamId, 'error', 'NetStream.Play.BadConnection', 'Connection already playing');
    } else if (!this.publishers.has(this.playStreamPath)) {
      console.log("[rtmp play] stream not found " + this.playStreamPath + ' streamId:' + this.playStreamId);
      this.respondPlay();
      // this.sendStreamEmpty();
      this.isIdling = true;
      this.idlePlayers.add(this.id);
    } else {
      if (this.isIdling) {
        this.sendStatusMessage(this.playStreamId, 'status', 'NetStream.Play.PublishNotify', `${this.publishStreamPath} is now published.`);
      } else {
        this.respondPlay();
      }
      let publisherPath = this.publishers.get(this.playStreamPath);
      let publisher = this.sessions.get(publisherPath);
      let players = publisher.players;

      this.isPlaying = true;
      //metaData
      if (publisher.metaData != null) {
        let rtmpHeader = {
          chunkStreamID: 5,
          timestamp: 0,
          messageTypeID: 0x12,
          messageStreamID: this.playStreamId
        };

        let metaDataRtmpMessage = this.createRtmpMessage(rtmpHeader, publisher.metaData);
        this.socket.write(metaDataRtmpMessage);
      }

      //send aacSequenceHeader
      if (publisher.audioCodec == 10) {
        let rtmpHeader = {
          chunkStreamID: 4,
          timestamp: 0,
          messageTypeID: 0x08,
          messageStreamID: this.playStreamId
        };
        let rtmpMessage = this.createRtmpMessage(rtmpHeader, publisher.aacSequenceHeader);
        this.socket.write(rtmpMessage);
      }
      //send avcSequenceHeader
      if (publisher.videoCodec == 7 || publisher.videoCodec == 12) {
        let rtmpHeader = {
          chunkStreamID: 6,
          timestamp: 0,
          messageTypeID: 0x09,
          messageStreamID: this.playStreamId
        };
        let rtmpMessage = this.createRtmpMessage(rtmpHeader, publisher.avcSequenceHeader);
        this.socket.write(rtmpMessage);
      }
      //send gop cache
      if (publisher.rtmpGopCacheQueue != null) {
        for (let rtmpMessage of publisher.rtmpGopCacheQueue) {
          rtmpMessage.writeUInt32LE(this.playStreamId, 8);
          this.socket.write(rtmpMessage);
        }
      }
      if (this.isIdling) {
        this.sendStreamStatus(STREAM_READY, this.playStreamId);
        this.isIdling = false;
      }

      console.log("[rtmp play] join stream " + this.playStreamPath + ' streamId:' + this.playStreamId);
      players.add(this.id);
    }
  }

  onCloseStream(streamID, del) {
    if (this.isIdling && this.playStreamId == streamID) {
      this.sendStatusMessage(this.playStreamId, 'status', 'NetStream.Play.Stop', 'Stopped playing stream.');
      this.idlePlayers.delete(this.id);
      this.isIdling = false;
      this.playStreamId = del ? 0 : this.playStreamId;
    }

    if (this.isPlaying && this.playStreamId == streamID) {
      this.sendStatusMessage(this.playStreamId, 'status', 'NetStream.Play.Stop', 'Stopped playing stream.');
      let publisherPath = this.publishers.get(this.playStreamPath);
      if (publisherPath != null) {
        this.sessions.get(publisherPath).players.delete(this.id);
      }
      this.isPlaying = false;
      this.playStreamId = del ? 0 : this.playStreamId;
    }

    if (this.isPublishing && this.publishStreamId == streamID) {
      this.sendStatusMessage(this.publishStreamId, 'status', 'NetStream.Unpublish.Success', `${this.publishStreamPath} is now unpublished.`);
      for (let playerId of this.players) {
        let player = this.sessions.get(playerId);
        if (player instanceof NodeRtmpSession) {
          player.sendStatusMessage(player.playStreamId, 'status', 'NetStream.Play.UnpublishNotify', 'stream is now unpublished.');
        } else {
          player.stop();
        }
      }

      //let the players to idlePlayers
      for (let playerId of this.players) {
        let player = this.sessions.get(playerId);
        this.idlePlayers.add(playerId);
        player.isPlaying = false;
        player.isIdling = true;
        if (player instanceof NodeRtmpSession) {
          player.sendStreamStatus(STREAM_EOF, player.playStreamId);
        }
      }

      this.players.clear();
      this.players = null;
      this.publishers.delete(this.publishStreamPath);
      this.isPublishing = false;
      this.publishStreamId = del ? 0 : this.publishStreamId;
    }
  }

  onDeleteStream(streamID) {
    this.onCloseStream(streamID, true);
  }
}

module.exports = NodeRtmpSession
