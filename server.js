const {
    RootMsg,
    MarioListMsg,
    ValidPlayersMsg,
    Sm64JsMsg,
    ConnectedMsg,
    SkinMsg,
    PlayerListsMsg,
    FlagMsg,
    PlayerNameMsg,
    AnnouncementMsg,
    ChatMsg
} = require("./proto/mario_pb")

const http = require('http')
const got = require('got')
const crypto = require('crypto-js')
const util = require('util')
const { v4: uuidv4 } = require('uuid')
const low = require('lowdb')
const FileSync = require('lowdb/adapters/FileSync')
const zlib = require('zlib')
const deflate = util.promisify(zlib.deflate)
const port = 3080
const ws_port = 3000

const adminTokens = process.env.PRODUCTION ? process.env.ADMIN_TOKENS.split(":") : ["testAdminToken"]
const ip_encryption_key = process.env.PRODUCTION ? process.env.IP_ENCRYPTION_KEY : "abcdef123456"

const adapter = (process.env.PRODUCTION && process.env.CUSTOMSERVER != 1) ? new FileSync('/tmp/data/db.json') : new FileSync('testdb.json')
const db = low(adapter)
db.defaults({ chats: [], adminCommands: [], ipList: [] }).write()

const standardLevels = require('./levelData').standardLevels

const allGames = {}
const publicLevelsToGameIds = {}
const socketIdsToGameIds = {}
let socketsInLobby = []

const connectedIPs = {}
const stats = {}

let currentId = 0
const generateID = () => {
    if (++currentId > 4294967294) currentId = 0
    return currentId
}

const sendData = (bytes, socket) => { if (!socket.closed) socket.send(bytes, true) }

const broadcastData = (bytes, gameID) => {
    if (gameID == "lobbySockets") { // send to lobbySockets
        socketsInLobby.forEach(socket => { sendData(bytes, socket) })
    } else if (gameID) { // send to single game
        if (allGames[gameID]) Object.values(allGames[gameID].players).forEach(x => { sendData(bytes, x.socket) })
    } else { /// send to all games 
        Object.values(allGames).forEach(gameData => {
            Object.values(gameData.players).forEach(x => { sendData(bytes, x.socket) })
        })
    }
}

const initNewLevel = (level, public) => {
    const gameID = uuidv4()

    const flagPositions = standardLevels[level].flagStartPositions

    const newFlagData = new Array(flagPositions.length).fill(0).map((_, i) => {
        return {
            pos: [...flagPositions[i]],
            linkedToPlayer: false,
            atStartPosition: true,
            socketID: null,
            idleTimer: 0,
            heightBeforeFall: 20000
        }
    })

    allGames[gameID] = {
        players: [],
        flagData: newFlagData,
        level,
        public,
        inactiveCount: 0
    }

    return gameID
}

const sendValidUpdate = () => {

    const allGamesValidPlayers = []

    Object.entries(allGames).forEach(([gameID, gameData]) => {

        const validPlayers = Object.values(gameData.players).filter(data => data.valid > 0).map(data => data.socket.my_id)
        const validplayersmsg = new ValidPlayersMsg()
        validplayersmsg.setValidplayersList(validPlayers)
        validplayersmsg.setLevelId(gameData.level)

        if (gameData.public) {  /// public server room
            allGamesValidPlayers.push(validplayersmsg)
        } 

        const playerListsMsg = new PlayerListsMsg()
        playerListsMsg.setGameList([validplayersmsg])
        const sm64jsMsg = new Sm64JsMsg()
        sm64jsMsg.setPlayerListsMsg(playerListsMsg)
        const rootMsg = new RootMsg()
        rootMsg.setUncompressedSm64jsMsg(sm64jsMsg)
        broadcastData(rootMsg.serializeBinary(), gameID)
    })

    /// send all public room data to lobbbySockets
    const playerListsMsg = new PlayerListsMsg()
    playerListsMsg.setGameList(allGamesValidPlayers)
    const sm64jsMsg = new Sm64JsMsg()
    sm64jsMsg.setPlayerListsMsg(playerListsMsg)
    const rootMsg = new RootMsg()
    rootMsg.setUncompressedSm64jsMsg(sm64jsMsg)
    broadcastData(rootMsg.serializeBinary(), "lobbySockets")

}

const processPlayerData = (socket_id, decodedMario) => {

    // ignoring validation for now
    if (decodedMario.getSocketid() != decodedMario.getController().getSocketid()) return
    if (decodedMario.getSocketid() != socket_id) return

    /// server should always force the socket_id - not needed if checking
    decodedMario.setSocketid(socket_id)

    const gameID = socketIdsToGameIds[socket_id]

    /// Data is Valid
    allGames[gameID].players[socket_id].decodedMario = decodedMario
    allGames[gameID].players[socket_id].valid = 100

}

const processSkin = (socket_id, skinMsg) => {

    const gameID = socketIdsToGameIds[socket_id]
    if (gameID == undefined) return 

    if (allGames[gameID].players[socket_id].valid == 0) return

    const skinData = skinMsg.getSkindata()

    allGames[gameID].players[socket_id].skinData = skinData
    allGames[gameID].players[socket_id].skinDataUpdated = true
}

const rejectPlayerName = (socket) => {
    const playerNameMsg = new PlayerNameMsg()
    playerNameMsg.setAccepted(false)
    const sm64jsMsg = new Sm64JsMsg()
    sm64jsMsg.setPlayerNameMsg(playerNameMsg)
    const rootMsg = new RootMsg()
    rootMsg.setUncompressedSm64jsMsg(sm64jsMsg)
    sendData(rootMsg.serializeBinary(), socket)
}

const sanitizeChat = (string) => {
    string = string.substring(0, 200)
    return applyValidCharacters(string)
}

//Valid characters for usernames.
const validCharacters = new Set([
    'a', 'b', 'c', 'd', 'e', 'f', 'g',
    'h', 'i', 'j', 'k', 'l', 'm', 'n',
    'o', 'p', 'q', 'r', 's', 't', 'u',
    'v', 'w', 'y', 'x', 'z', 'A', 'B',
    'C', 'D', 'E', 'F', 'G', 'H', 'I',
    'J', 'K', 'L', 'M', 'N', 'O', 'P',
    'Q', 'R', 'S', 'T', 'U', 'V', 'W',
    'Y', 'X', 'Z', '1', '2', '3', '4',
    '5', '6', '7', '8', '9', '0', '!',
    '@', '$', '^', '*', '(', ')', '{',
    '}', '[', ']', ';', ':', `'`, '"',
    `\\`, ',', '.', '/', '?', '🙄', '😫',
    '🤔', '🔥', '😌', '😍', '🤣', '❤️', '😭',
    '😂', '⭐', '✨', '🎄', '🎃', '🔺', '🔻',
    '🎄', '🍬', '🍭', '🍫', ' ',
    '-', '_', '=', '|', '<', '>', ':', "'"
]);


const applyValidCharacters = (str) => {
    return str.split('').filter(c => validCharacters.has(c)).join('');
}

const processAdminCommand = (msg, token, gameID) => {
    const parts = msg.split(' ')
    const command = parts[0].toUpperCase()
    const remainingParts = parts.slice(1)
    const args = remainingParts.join(" ")

    switch (command) {
        case "ANNOUNCEMENT":
            const announcementMsg = new AnnouncementMsg()
            announcementMsg.setMessage(args)
            announcementMsg.setTimer(300)
            const sm64jsMsg = new Sm64JsMsg()
            sm64jsMsg.setAnnouncementMsg(announcementMsg)
            const rootMsg = new RootMsg()
            rootMsg.setUncompressedSm64jsMsg(sm64jsMsg)
            broadcastData(rootMsg.serializeBinary(), gameID)
            break
        default:  return console.log("Unknown Admin Command: " + parts[0])
    }

    db.get('adminCommands').push({ token, gameID, timestampMs: Date.now(), command, args }).write()
}

const processChat = async (socket_id, sm64jsMsg) => {
    const chatMsg = sm64jsMsg.getChatMsg()
    const message = chatMsg.getMessage()

    const gameID = socketIdsToGameIds[socket_id]
    if (gameID == undefined) return 

    const playerData = allGames[gameID].players[socket_id]
    if (playerData == undefined) return

    /// Throttle chats by IP
    if (connectedIPs[playerData.socket.ip].chatCooldown > 10) {
        const chatMsg = new ChatMsg()
        chatMsg.setSocketid(socket_id)
        chatMsg.setMessage("Chat message ignored: You have to wait longer between sending chat messages")
        chatMsg.setSender("Server")
        const sm64jsMsg = new Sm64JsMsg()
        sm64jsMsg.setChatMsg(chatMsg)
        const rootMsg = new RootMsg()
        rootMsg.setUncompressedSm64jsMsg(sm64jsMsg)
        sendData(rootMsg.serializeBinary(), playerData.socket)
        return
    }

    if (message.length == 0) return

    const adminToken = chatMsg.getAdmintoken()
    const isAdmin = adminToken != null && adminTokens.includes(adminToken)

    if (message[0] == '/') {
        if (isAdmin) processAdminCommand(message.slice(1), adminToken, gameID)
        return
    }

    const decodedMario = playerData.decodedMario
    if (decodedMario == undefined) return

    connectedIPs[playerData.socket.ip].chatCooldown += 3 // seconds

    /// record chat to DB
    db.get('chats').push({
        socketID: socket_id,
        playerName: playerData.playerName,
        ip: playerData.socket.ip,
        timestampMs: Date.now(),
        message,
        adminToken
    }).write()

    const sanitizedChat = sanitizeChat(message)

    const request = "http://www.purgomalum.com/service/json?text=" + sanitizedChat

    try {
        const filteredMessage = JSON.parse((await got(request)).body).result

        chatMsg.setSocketid(socket_id)
        chatMsg.setMessage(filteredMessage)
        chatMsg.setSender(playerData.playerName)
        chatMsg.setIsadmin(isAdmin)

        const rootMsg = new RootMsg()
        rootMsg.setUncompressedSm64jsMsg(sm64jsMsg)
        broadcastData(rootMsg.serializeBinary(), gameID)

    } catch (e) {
        console.log(`Got error with profanity api: ${e}`)
    }

}

const processPlayerName = async (socket, msg) => {

    if (socketIdsToGameIds[socket.my_id] != undefined) return ///already initialized

    const name = msg.getName()

    if (name.length < 3 || name.length > 14 || name.toUpperCase() == "SERVER") {
        return rejectPlayerName(socket)
    }

    const sanitizedName = sanitizeChat(name)

    if (sanitizedName != name) {
        return rejectPlayerName(socket)
    }

    const playerNameRequest = "http://www.purgomalum.com/service/json?text=" + sanitizedName

    try {
        const filteredPlayerName = JSON.parse((await got(playerNameRequest)).body).result

        if (sanitizedName != filteredPlayerName) {
            return rejectPlayerName(socket)
        }

        const level = msg.getLevel()
        let gameID

        if (level == 0) { /// custom game room
            gameID = msg.getGameId()
            if (allGames[gameID] == undefined) return rejectPlayerName(socket)
        } else {  /// normal server room
            if (standardLevels[level] == undefined) return rejectPlayerName(socket)
            gameID = publicLevelsToGameIds[level]
            if (allGames[gameID] == undefined) {  //// public room doesn't exist, create
                gameID = initNewLevel(level, true)
                publicLevelsToGameIds[level] = gameID
            }
        }

        allGames[gameID].inactiveCount = 0 /// some activity

        //filteredPlayerName should equal the original name at this point
        const takenPlayerNames = Object.values(allGames[gameID].players).map(obj => obj.playerName)
        if (takenPlayerNames.includes(filteredPlayerName)) return rejectPlayerName(socket)

        ////Success point - should initialize player
        allGames[gameID].players[socket.my_id] = {
            socket, /// also contains socket_id and ip
            playerName: filteredPlayerName,
            valid: 0,
            decodedMario: undefined,
            skinData: undefined
        }
        socketIdsToGameIds[socket.my_id] = gameID

        socketsInLobby = socketsInLobby.filter((lobbySocket) => { return lobbySocket != socket })

        const playerNameMsg = new PlayerNameMsg()
        playerNameMsg.setName(filteredPlayerName)
        playerNameMsg.setLevel(allGames[gameID].level)
        playerNameMsg.setAccepted(true)
        const sm64jsMsg = new Sm64JsMsg()
        sm64jsMsg.setPlayerNameMsg(playerNameMsg)
        const rootMsg = new RootMsg()
        rootMsg.setUncompressedSm64jsMsg(sm64jsMsg)
        sendData(rootMsg.serializeBinary(), socket)

    } catch (e) {
        console.log(`Got error with profanity api: ${e}`)
        return rejectPlayerName(socket)
    }


}

const sendSkinsToSocket = (socket) => { 

    setTimeout(() => {
        const gameID = socketIdsToGameIds[socket.my_id]
        if (gameID == undefined || allGames[gameID] == undefined) {
            return  /// if they disconnect in this 500ms period
        }
        /// Send Skins
        Object.entries(allGames[gameID].players).filter(([_, data]) => data.skinData).forEach(([socket_id, data]) => {
            const skinMsg = new SkinMsg()
            skinMsg.setSocketid(socket_id)
            skinMsg.setSkindata(data.skinData)
            skinMsg.setPlayername(data.playerName)
            const sm64jsMsg = new Sm64JsMsg()
            sm64jsMsg.setSkinMsg(skinMsg)
            const rootMsg = new RootMsg()
            rootMsg.setUncompressedSm64jsMsg(sm64jsMsg)
            sendData(rootMsg.serializeBinary(), socket)
        })
    }, 500)

}
const sendSkinsIfUpdated = () => {

    Object.entries(allGames).forEach(([gameID, gameData]) => {
        /// Send Skins
        Object.entries(gameData.players).filter(([_, data]) => data.skinData && data.skinDataUpdated).forEach(([socket_id, data]) => {
            const skinMsg = new SkinMsg()
            skinMsg.setSocketid(socket_id)
            skinMsg.setSkindata(data.skinData)
            skinMsg.setPlayername(data.playerName)
            const sm64jsMsg = new Sm64JsMsg()
            sm64jsMsg.setSkinMsg(skinMsg)
            const rootMsg = new RootMsg()
            rootMsg.setUncompressedSm64jsMsg(sm64jsMsg)

            data.skinDataUpdated = false

            broadcastData(rootMsg.serializeBinary(), gameID)
        })
    })

}

const processBasicAttack = (attackerID, attackMsg) => {

    const gameID = socketIdsToGameIds[attackerID]
    if (gameID == undefined) return

    const playerData = allGames[gameID].players[attackerID]
    if (playerData == undefined) return

    /// redundant
    attackMsg.setAttackerSocketId(attackerID)

    const flagIndex = attackMsg.getFlagId()
    const targetId = attackMsg.getTargetSocketId()

    const theFlag = allGames[gameID].flagData[flagIndex]

    if (theFlag.linkedToPlayer && theFlag.socketID == targetId) {
        theFlag.linkedToPlayer = false
        theFlag.socketID = null
        theFlag.fallmode = true
        const newFlagLocation = playerData.decodedMario.getPosList()
        newFlagLocation[0] += ((Math.random() * 1000.0) - 500.0)
        newFlagLocation[1] += 600
        newFlagLocation[2] += ((Math.random() * 1000.0) - 500.0)
        theFlag.heightBeforeFall = newFlagLocation[1]
        theFlag.pos = [parseInt(newFlagLocation[0]), parseInt(newFlagLocation[1]), parseInt(newFlagLocation[2])]
    }

}

const processGrabFlagRequest = (socket_id, grabFlagMsg) => {

    const gameID = socketIdsToGameIds[socket_id]
    if (gameID == undefined) return

    const playerData = allGames[gameID].players[socket_id]
    if (playerData == undefined) return

    const i = grabFlagMsg.getFlagId()

    const theFlag = allGames[gameID].flagData[i]

    if (theFlag.linkedToPlayer) return

    const pos = grabFlagMsg.getPosList()

    const xDiff = pos[0] - theFlag.pos[0]
    const zDiff = pos[2] - theFlag.pos[2]

    const dist = Math.sqrt(xDiff * xDiff + zDiff * zDiff)
    if (dist < 50) {
        theFlag.linkedToPlayer = true
        theFlag.fallmode = false
        theFlag.atStartPosition = false
        theFlag.socketID = socket_id
        theFlag.idleTimer = 0
    }
}

const checkForFlag = (socket_id) => {

    Object.values(allGames).forEach(gameData => {
        gameData.flagData.forEach(flag => {
            if (flag.socketID == socket_id) {

                const playerData = gameData.players[socket_id]
                if (playerData == undefined) return

                flag.linkedToPlayer = false
                flag.socketID = null
                flag.fallmode = true
                const newFlagLocation = playerData.decodedMario.getPosList()
                newFlagLocation[1] += 100
                flag.heightBeforeFall = newFlagLocation[1]
                flag.pos = [parseInt(newFlagLocation[0]), parseInt(newFlagLocation[1]), parseInt(newFlagLocation[2])]
            }

        })
    })

}

const serverSideFlagUpdate = () => {

    Object.values(allGames).forEach(gameData => {
        gameData.flagData.forEach((flag, flagIndex) => {
            if (flag.fallmode) {
                if (flag.pos[1] > -10000) flag.pos[1] -= 2
            }

            if (!flag.linkedToPlayer && !flag.atStartPosition) {
                flag.idleTimer++
                if (flag.idleTimer > 3000) {

                    flag.pos = [...standardLevels[gameData.level].flagStartPositions[flagIndex]]
                    flag.fallmode = false
                    flag.atStartPosition = true
                    flag.idleTimer = 0
                }
            }
        })
    })

}


/// 20 times per second
setInterval(async () => {

    serverSideFlagUpdate()

    Object.values(allGames).forEach(gameData => {
        Object.values(gameData.players).forEach(playerData => {
            if (playerData.valid > 0) playerData.valid--
            else if (playerData.decodedMario) playerData.socket.close()
        })
    })

    Object.entries(allGames).forEach(async ([gameID, gameData]) => {
        const sm64jsMsg = new Sm64JsMsg()
        const mariolist = Object.values(gameData.players).filter(data => data.decodedMario).map(data => data.decodedMario)
        const mariolistproto = new MarioListMsg()
        mariolistproto.setMarioList(mariolist)

        const flagProtoList = []

        for (let i = 0; i < gameData.flagData.length; i++) {
            const theFlag = gameData.flagData[i]
            const flagmsg = new FlagMsg()
            flagmsg.setLinkedtoplayer(theFlag.linkedToPlayer)
            if (theFlag.linkedToPlayer) flagmsg.setSocketid(theFlag.socketID)
            else {
                flagmsg.setPosList(theFlag.pos)
                flagmsg.setHeightBeforeFall(theFlag.heightBeforeFall)
            }
            flagProtoList.push(flagmsg)
        }

        mariolistproto.setFlagList(flagProtoList)

        sm64jsMsg.setListMsg(mariolistproto)
        const bytes = sm64jsMsg.serializeBinary()
        const compressedBytes = await deflate(bytes)
        const rootMsg = new RootMsg()
        rootMsg.setCompressedSm64jsMsg(compressedBytes)
        broadcastData(rootMsg.serializeBinary(), gameID)
    })


}, 33)

/// Every 33 frames / once per second
setInterval(() => {
    sendValidUpdate()

    //chat cooldown
    Object.values(connectedIPs).forEach(data => {
        if (data.chatCooldown > 0) data.chatCooldown--
    })
}, 1000)

/// Every 10 seconds - send skins
setInterval(() => {

    sendSkinsIfUpdated()

}, 10000)


/// Every 5 minutes - delete inactive games
setInterval(() => {

    Object.entries(allGames).forEach(([gameID, gameData]) => {

        if (Object.values(gameData.players).length == 0) { //inactive game
            gameData.inactiveCount++

            if (gameData.inactiveCount >= 5) {
                /// delete game
                delete allGames[gameID]
                delete publicLevelsToGameIds[gameData.level]
            }

        }

    })

}, 300000)

//Every 1 day - Auto Delete Old chat entries
setInterval(() => {
    const threeDaysAgo = Date.now() - (86400000 * 3)
    db.get('chats').remove((entry) => {
        if (entry.timestampMs < threeDaysAgo) return true
    }).write()
}, 86400000) //1 Days


require('uWebSockets.js').App().ws('/*', {

    upgrade: async (res, req, context) => { // a request was made to open websocket, res req have all the properties for the request, cookies etc

        // add code here to determine if ws request should be accepted or denied
        // can deny request with "return res.writeStatus('401').end()" see issue #367

        const ip = req.getHeader('x-forwarded-for')

        if (connectedIPs[ip]) {
            if (Object.keys(connectedIPs[ip].socketIDs).length >= 4) return res.writeStatus('403').end()
        }

        const key = req.getHeader('sec-websocket-key')
        const protocol = req.getHeader('sec-websocket-protocol')
        const extensions = req.getHeader('sec-websocket-extensions')

        res.onAborted(() => {})

        if (process.env.PRODUCTION) {

            try {

                //console.log("someone trying to connect: " + ip)

                ///// check CORS
                let originHeader = req.getHeader('origin')
                const url = new URL(originHeader)
                const domainStr = url.hostname.substring(url.hostname.length - 11, url.hostname.length)
                if (domainStr != ".sm64js.com" && url.hostname != "sm64js.com") return res.writeStatus('418').end()

                const ipStatus = db.get('ipList').find({ ip }).value()

                if (ipStatus == undefined) {

                    //console.log("trying to hit vpn api")
                    const vpnCheckRequest = `http://v2.api.iphub.info/ip/${ip}`
                    const initApiReponse = await got(vpnCheckRequest, {
                        headers: { 'X-Key': process.env.VPN_API_KEY }
                    })
                    const response = JSON.parse(initApiReponse.body)

                    if (response.block == undefined) {
                        console.log("iphub reponse invalid")
                        return res.writeStatus('500').end()
                    }

                    if (response.block == 1) {
                        db.get('ipList').push({ ip, value: 'BANNED', reason: 'AutoVPN' }).write()
                       // console.log("Adding new VPN BAD IP " + ip)
                        return res.writeStatus('403').end()
                    } else {
                        //console.log("Adding new Legit IP")
                        db.get('ipList').push({ ip, value: 'ALLOWED' }).write()
                    }

                } else if (ipStatus.value == "BANNED") {  /// BANNED or NOT ALLOWED IP
                    //console.log("BANNED IP tried to connect")
                    return res.writeStatus('403').end()
                } else if (ipStatus.value == "ALLOWED") { /// Whitelisted IP - OKAY
                    //console.log("Known Whitelisted IP connecting")
                }

            } catch (e) {
                console.log(`Got error with upgrading to websocket: ${e}`)
                return res.writeStatus('500').end()
            }

        }
        
        res.upgrade( // upgrade to websocket
            { ip }, // 1st argument sets which properties to pass to the ws object, in this case ip address
            key,
            protocol,
            extensions, // these 3 headers are used to setup the websocket
            context // also used to setup the websocket
        )


    },

    open: async (socket) => {
        socket.my_id = generateID()

        if (connectedIPs[socket.ip] == undefined)
            connectedIPs[socket.ip] = { socketIDs: {}, chatCooldown: 15 }

        connectedIPs[socket.ip].socketIDs[socket.my_id] = 1

        socketsInLobby.push(socket)
        
        const connectedMsg = new ConnectedMsg()
        connectedMsg.setSocketid(socket.my_id)
        const sm64jsMsg = new Sm64JsMsg()
        sm64jsMsg.setConnectedMsg(connectedMsg)
        const rootMsg = new RootMsg()
        rootMsg.setUncompressedSm64jsMsg(sm64jsMsg)
        sendData(rootMsg.serializeBinary(), socket)
    },

    message: async (socket, bytes) => {

        try {
            let sm64jsMsg
            const rootMsg = RootMsg.deserializeBinary(bytes)

            switch (rootMsg.getMessageCase()) {
                case RootMsg.MessageCase.UNCOMPRESSED_SM64JS_MSG:

                    sm64jsMsg = rootMsg.getUncompressedSm64jsMsg()
                    switch (sm64jsMsg.getMessageCase()) {
                        case Sm64JsMsg.MessageCase.MARIO_MSG:
                            if (socketIdsToGameIds[socket.my_id] == undefined) return 
                            processPlayerData(socket.my_id, sm64jsMsg.getMarioMsg()); break
                        case Sm64JsMsg.MessageCase.PING_MSG:
                            if (socketIdsToGameIds[socket.my_id] == undefined) return 
                            sendData(bytes, socket); break
                        case Sm64JsMsg.MessageCase.ATTACK_MSG:
                            if (socketIdsToGameIds[socket.my_id] == undefined) return 
                            processBasicAttack(socket.my_id, sm64jsMsg.getAttackMsg()); break
                        case Sm64JsMsg.MessageCase.GRAB_MSG:
                            if (socketIdsToGameIds[socket.my_id] == undefined) return 
                            processGrabFlagRequest(socket.my_id, sm64jsMsg.getGrabMsg()); break
                        case Sm64JsMsg.MessageCase.CHAT_MSG:
                            if (socketIdsToGameIds[socket.my_id] == undefined) return 
                            processChat(socket.my_id, sm64jsMsg); break
                        case Sm64JsMsg.MessageCase.INIT_MSG:
                            sendSkinsToSocket(socket); break
                        case Sm64JsMsg.MessageCase.SKIN_MSG:
                            if (socketIdsToGameIds[socket.my_id] == undefined) return 
                            processSkin(socket.my_id, sm64jsMsg.getSkinMsg()); break
                        case Sm64JsMsg.MessageCase.PLAYER_NAME_MSG:
                            processPlayerName(socket, sm64jsMsg.getPlayerNameMsg()); break
                        default: throw "unknown case for uncompressed proto message"
                    }
                    break
                case RootMsg.MessageCase.MESSAGE_NOT_SET:
                default:
                    if (rootMsg.getMessageCase() != 0)
                        throw new Error(`unhandled case in switch expression: ${rootMsg.getMessageCase()}`)
            }


        } catch (err) { console.log(err) }
    },

    close: (socket) => {
        socket.closed = true
        checkForFlag(socket.my_id)
        delete connectedIPs[socket.ip].socketIDs[socket.my_id]

        socketsInLobby = socketsInLobby.filter((lobbySocket) => { return lobbySocket != socket })

        const gameID = socketIdsToGameIds[socket.my_id]
        if (gameID) {
            delete allGames[gameID].players[socket.my_id]
            delete socketIdsToGameIds[socket.my_id]
        }
    }

}).listen(ws_port, () => { console.log("Starting websocket server " + ws_port) })

//// Express Static serving
const express = require('express')
const app = express()
const server = http.Server(app)

app.use(express.urlencoded({ extended: true }))

server.listen(port, () => { console.log('Starting Express server for http requests ' + port) })


////// Admin Commands
app.get('/banIP/:token/:ip', (req, res) => {

    const token = req.params.token
    const ip = crypto.AES.decrypt(decodeURIComponent(req.params.ip), ip_encryption_key).toString(crypto.enc.Utf8)

    if (!adminTokens.includes(token)) return res.status(401).send('Invalid Admin Token')

    const ipObject = db.get('ipList').find({ ip })
    const ipValue = ipObject.value()

    db.get('adminCommands').push({ token, timestampMs: Date.now(), command: 'banIP', args: [ ip ] }).write()

    if (ipValue == undefined) {
        db.get('ipList').push({ ip, value: 'BANNED', reason: 'Manual' }).write()
        console.log("Admin BAD IP " + ip + "  " + token)

        return res.send("IP BAN SUCCESS")
    } else if (ipValue.value == "ALLOWED") {
        ipObject.assign({ value: 'BANNED', reason: 'Manual'  }).write()
        console.log("Admin BAD Existing IP " + ip + "  " + token)

        ///kick
        Object.values(allGames).forEach(gameData => {
            Object.values(gameData.players).forEach(data => {
                if (data.socket.ip == ip) data.socket.close()
            })
        })

        return res.send("IP BAN SUCCESS")
    } else if (ipValue.value == "BANNED") {
        return res.send("This IP is already BANNED")
    }

})

app.get('/allowIP/:token/:ip/:plaintext?', (req, res) => {

    const token = req.params.token
    const ip = req.params.plaintext ? req.params.ip : crypto.AES.decrypt(decodeURIComponent(req.params.ip), ip_encryption_key).toString(crypto.enc.Utf8)

    if (!adminTokens.includes(token)) return res.status(401).send('Invalid Admin Token')

    const ipObject = db.get('ipList').find({ ip })
    const ipValue = ipObject.value()

    db.get('adminCommands').push({ token, timestampMs: Date.now(), command: 'allowIP', args: [ip] }).write()

    if (ipValue == undefined) {
        console.log("admin allowIP could not find")
        return res.send("This IP was not found in the banned list")
    } else if (ipValue.value == "BANNED") {
        ipObject.assign({ value: 'ALLOWED' }).write()
        console.log("Admin - Allowing Existing IP " + ip + "  " + token)

        return res.send("SUCCESS - Unbanning Requested IP")
    } else if (ipValue.value == "ALLOWED") {
        console.log("Admin Allow - already allowed")
        return res.send("This IP is already marked as allowed")
    }

})

app.get('/chatLog/:token/:timestamp?/:range?', (req, res) => {

    const token = req.params.token
    const timestamp = (req.params.timestamp && req.params.timestamp != '0') ? parseInt(req.params.timestamp) * 1000 : Date.now()
    const range = parseInt(req.params.range ? req.params.range : 60) * 1000

    if (adminTokens.includes(token)) {
        let stringResult = 'socketID,playerName,ip,message <br />'

        db.get('chats').forEach((entry) => {
            if (entry.timestampMs >= timestamp - range && entry.timestampMs <= timestamp + range) {
                const encrypted_ip = encodeURIComponent(crypto.AES.encrypt(entry.ip, ip_encryption_key).toString())
                stringResult += `${entry.socketID},${entry.playerName},${encrypted_ip},${entry.message} <br />`
            }
        }).value()
        
        return res.send(stringResult)
    } else {
        res.status(401).send('Invalid Admin Token')
    }

})

app.get('/adminLog/:token', (req, res) => {

    const token = req.params.token

    if (token != process.env.IP_ENCRYPTION_KEY) return

    let stringResult = ""

    db.get('adminCommands').forEach((entry) => {
        stringResult += JSON.stringify(entry)
        stringResult += '<br />'
    }).value()

    return res.send(stringResult)

})

app.get('/createGame', (req, res) => {
    res.sendFile(__dirname + '/createGameForm.html')
})

app.post('/createNewGame', (req, res) => {

    const level = parseInt(req.body.level)

    if (standardLevels[level] == undefined) return res.status(401).send('Invalid Level/Map ID')

    const gameID = initNewLevel(level, false)

    return res.send(`Invite Link: <a href="https://sm64js.com/?gameID=${gameID}">https://sm64js.com/?gameID=${gameID}</a>`)

})