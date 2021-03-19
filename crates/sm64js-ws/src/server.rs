use crate::{Client, Clients, Player, Players, Rooms};
use actix::{prelude::*, Recipient};
use anyhow::Result;
use censor::Censor;
use dashmap::{mapref::one::Ref, DashMap};
use parking_lot::RwLock;
use prost::Message as ProstMessage;
use rand::{self, Rng};
use sm64js_auth::{AuthInfo, Permission};
use sm64js_common::{ChatError, ChatHistoryData, ChatResult, PlayerInfo};
use sm64js_proto::{
    root_msg, sm64_js_msg, AnnouncementMsg, AttackMsg, ChatMsg, GrabFlagMsg, JoinGameMsg, MarioMsg,
    RootMsg, SkinMsg, Sm64JsMsg,
};
use std::{collections::HashMap, sync::Arc};
use v_htmlescape::escape;

lazy_static! {
    pub static ref PRIVILEGED_COMMANDS: HashMap<&'static str, Permission> = hashmap! {
        "ANNOUNCEMENT" => Permission::SendAnnouncement
    };
}

#[derive(Message)]
#[rtype(result = "()")]
pub enum Message {
    SendData(Vec<u8>),
    Kick,
}

pub struct Sm64JsServer {
    clients: Arc<Clients>,
    players: Players,
    rooms: Rooms,
    chat_history: ChatHistoryData,
}

impl Actor for Sm64JsServer {
    type Context = Context<Self>;

    fn started(&mut self, _: &mut Self::Context) {}
}

#[derive(Message)]
#[rtype(u32)]
pub struct Connect {
    pub addr: Recipient<Message>,
    pub auth_info: AuthInfo,
    pub ip: String,
    pub real_ip: Option<String>,
}

impl Handler<Connect> for Sm64JsServer {
    type Result = u32;

    fn handle(&mut self, msg: Connect, _: &mut Context<Self>) -> Self::Result {
        let socket_id = rand::thread_rng().gen::<u32>();
        let client = Client::new(msg.addr, msg.auth_info, msg.ip, msg.real_ip, socket_id);

        self.clients.insert(socket_id, client);
        socket_id
    }
}

#[derive(Message)]
#[rtype(result = "()")]
pub struct Disconnect {
    pub socket_id: u32,
}

impl Handler<Disconnect> for Sm64JsServer {
    type Result = ();

    fn handle(&mut self, msg: Disconnect, _: &mut Context<Self>) {
        self.clients.remove(&msg.socket_id);
        self.players.remove(&msg.socket_id);
    }
}

#[derive(Message)]
#[rtype(result = "()")]
pub struct SetData {
    pub socket_id: u32,
    pub data: MarioMsg,
}

impl Handler<SetData> for Sm64JsServer {
    type Result = ();

    fn handle(&mut self, msg: SetData, _: &mut Context<Self>) {
        if let Some(mut client) = self.clients.get_mut(&msg.socket_id) {
            client.set_data(msg.data);
        }
    }
}

#[derive(Message)]
#[rtype(result = "()")]
pub struct SendAttack {
    pub socket_id: u32,
    pub attack_msg: AttackMsg,
}

impl Handler<SendAttack> for Sm64JsServer {
    type Result = ();

    fn handle(&mut self, send_attack: SendAttack, _: &mut Context<Self>) {
        let socket_id = send_attack.socket_id;
        let attack_msg = send_attack.attack_msg;
        if let Some((level_id, attacker_pos)) = self
            .clients
            .get(&socket_id)
            .map(|client| try { (client.get_level()?, client.get_pos()?.clone()) })
            .flatten()
        {
            if let Some(room) = self.rooms.get(&level_id) {
                let flag_id = attack_msg.flag_id as usize;
                let target_id = attack_msg.target_socket_id;
                room.process_attack(flag_id, attacker_pos, target_id);
            }
        }
    }
}

#[derive(Message)]
#[rtype(result = "()")]
pub struct SendGrabFlag {
    pub socket_id: u32,
    pub grab_flag_msg: GrabFlagMsg,
}

impl Handler<SendGrabFlag> for Sm64JsServer {
    type Result = ();

    fn handle(&mut self, send_grab: SendGrabFlag, _: &mut Context<Self>) {
        let socket_id = send_grab.socket_id;
        let grab_flag_msg = send_grab.grab_flag_msg;
        if let Some(level_id) = self
            .clients
            .get(&socket_id)
            .map(|client| client.get_level())
            .flatten()
        {
            if let Some(room) = self.rooms.get(&level_id) {
                let flag_id = grab_flag_msg.flag_id as usize;
                let pos = grab_flag_msg.pos;
                room.process_grab_flag(flag_id, pos, socket_id);
            }
        }
    }
}

#[derive(Message)]
#[rtype(result = "Option<Vec<u8>>")]
pub struct SendChat {
    pub socket_id: u32,
    pub chat_msg: ChatMsg,
    pub auth_info: AuthInfo,
}

impl Handler<SendChat> for Sm64JsServer {
    type Result = Option<Vec<u8>>;

    fn handle(&mut self, send_chat: SendChat, _: &mut Context<Self>) -> Self::Result {
        let socket_id = send_chat.socket_id;
        let chat_msg = send_chat.chat_msg;
        let auth_info = send_chat.auth_info;

        let msg = if chat_msg.message.starts_with('/') {
            Ok(Self::handle_command(chat_msg, auth_info))
        } else if let Some(player) = self.players.get(&socket_id) {
            self.handle_chat(player, chat_msg, auth_info)
        } else {
            Ok(None)
        };

        match msg {
            Ok(Some(msg)) => {
                let level = self.clients.get(&socket_id)?.get_level()?;
                let room = self.rooms.get(&level)?;
                room.broadcast_message(&msg);
                None
            }
            Ok(None) => None,
            Err(msg) => Some(msg),
        }
    }
}

#[derive(Message)]
#[rtype(result = "()")]
pub struct SendSkin {
    pub socket_id: u32,
    pub skin_msg: SkinMsg,
}

impl Handler<SendSkin> for Sm64JsServer {
    type Result = ();

    fn handle(&mut self, send_skin: SendSkin, _: &mut Context<Self>) {
        let socket_id = send_skin.socket_id;
        let skin_msg = send_skin.skin_msg;
        if let Some(player) = self.players.get_mut(&socket_id) {
            player.write().set_skin_data(skin_msg.skin_data);
        }
    }
}

#[derive(Message)]
#[rtype(result = "Option<JoinGameAccepted>")]
pub struct SendJoinGame {
    pub socket_id: u32,
    pub join_game_msg: JoinGameMsg,
    pub auth_info: AuthInfo,
}

impl Handler<SendJoinGame> for Sm64JsServer {
    type Result = Option<JoinGameAccepted>;

    fn handle(&mut self, send_join_game: SendJoinGame, _: &mut Context<Self>) -> Self::Result {
        let join_game_msg = send_join_game.join_game_msg;
        let socket_id = send_join_game.socket_id;
        let auth_info = send_join_game.auth_info;
        if let Some(mut room) = self.rooms.get_mut(&join_game_msg.level) {
            if room.has_player(socket_id) {
                None
            } else {
                let name = if join_game_msg.use_discord_name {
                    auth_info.get_discord_username()?
                } else {
                    if !Self::is_name_valid(&join_game_msg.name) {
                        return None;
                    }
                    join_game_msg.name
                };
                let level = join_game_msg.level;
                if level == 0 {
                    // TODO is custom game
                    None
                } else {
                    let player = Arc::new(RwLock::new(Player::new(
                        self.clients.clone(),
                        socket_id,
                        level,
                        name.clone(),
                    )));
                    // TODO check duplicate custom name
                    room.add_player(socket_id, Arc::downgrade(&player));
                    if let Some(mut client) = self.clients.get_mut(&socket_id) {
                        client.set_level(level);
                    }
                    self.players.insert(socket_id, player);
                    Some(JoinGameAccepted { level, name })
                }
            }
        } else {
            None
        }
    }
}

#[derive(Message)]
#[rtype(result = "Result<()>")]
pub struct KickClientByAccountId {
    pub account_id: i32,
}

impl Handler<KickClientByAccountId> for Sm64JsServer {
    type Result = Result<()>;

    fn handle(&mut self, msg: KickClientByAccountId, _: &mut Context<Self>) -> Self::Result {
        let account_id = msg.account_id;
        let socket_id = {
            if let Some(client) = self.get_client_by_account_id(account_id) {
                client.send(Message::Kick)?;
                Some(client.get_socket_id())
            } else {
                None
            }
        };
        if let Some(socket_id) = socket_id {
            self.clients.remove(&socket_id);
            self.players.remove(&socket_id);
        }
        Ok(())
    }
}

#[derive(Debug)]
pub struct JoinGameAccepted {
    pub level: u32,
    pub name: String,
}

#[derive(Message)]
#[rtype(result = "Option<RequestCosmeticsAccepted>")]
pub struct SendRequestCosmetics {
    pub socket_id: u32,
}

impl Handler<SendRequestCosmetics> for Sm64JsServer {
    type Result = Option<RequestCosmeticsAccepted>;

    fn handle(
        &mut self,
        send_request_cosmetics: SendRequestCosmetics,
        _: &mut Context<Self>,
    ) -> Self::Result {
        let socket_id = send_request_cosmetics.socket_id;
        let level = self.clients.get(&socket_id)?.get_level()?;
        let room = self.rooms.get(&level)?;

        Some(RequestCosmeticsAccepted(room.get_all_skin_data().ok()?))
    }
}

#[derive(Debug)]
pub struct RequestCosmeticsAccepted(pub Vec<Vec<u8>>);

impl Sm64JsServer {
    pub fn new(chat_history: ChatHistoryData, rooms: Rooms) -> Self {
        Sm64JsServer {
            clients: Arc::new(DashMap::new()),
            players: HashMap::new(),
            rooms,
            chat_history,
        }
    }

    pub fn create_uncompressed_msg(msg: sm64_js_msg::Message) -> Vec<u8> {
        let root_msg = RootMsg {
            message: Some(root_msg::Message::UncompressedSm64jsMsg(Sm64JsMsg {
                message: Some(msg),
            })),
        };
        let mut msg = vec![];
        root_msg.encode(&mut msg).unwrap();

        msg
    }

    pub fn get_players(&self) -> Vec<PlayerInfo> {
        self.players
            .iter()
            .filter_map(|player| {
                let player = player.1.read();
                let client = self.clients.get(&player.get_socket_id())?;
                Some(PlayerInfo {
                    account_id: client.get_account_id(),
                    socket_id: player.get_socket_id(),
                    ip: client.get_ip().to_string(),
                    real_ip: client.get_real_ip().cloned(),
                    level: player.get_level(),
                    name: player.get_name().clone(),
                })
            })
            .collect()
    }

    fn get_client_by_account_id(&self, account_id: i32) -> Option<Ref<u32, Client>> {
        self.clients
            .iter()
            .find(|client| client.get_account_id() == account_id)
            .map(|client| {
                let socket_id = client.value().get_socket_id();
                self.clients.get(&socket_id)
            })
            .flatten()
    }

    fn handle_command(chat_msg: ChatMsg, auth_info: AuthInfo) -> Option<Vec<u8>> {
        let message = chat_msg.message;
        if let Some(index) = message.find(' ') {
            let (cmd, message) = message.split_at(index);
            if let Some(permission) = PRIVILEGED_COMMANDS.get(cmd) {
                if !auth_info.has_permission(permission) {
                    return None;
                }
            }
            match cmd.to_ascii_uppercase().as_ref() {
                // TODO store in enum
                "ANNOUNCEMENT" => {
                    let root_msg = RootMsg {
                        message: Some(root_msg::Message::UncompressedSm64jsMsg(Sm64JsMsg {
                            message: Some(sm64_js_msg::Message::AnnouncementMsg(AnnouncementMsg {
                                message: message.to_string(),
                                timer: 300,
                            })),
                        })),
                    };

                    let mut msg = vec![];
                    root_msg.encode(&mut msg).unwrap();
                    Some(msg)
                }
                _ => None,
            }
        } else {
            None
        }
    }

    fn handle_chat(
        &self,
        player: &Arc<RwLock<Player>>,
        mut chat_msg: ChatMsg,
        auth_info: AuthInfo,
    ) -> Result<Option<Vec<u8>>, Vec<u8>> {
        let socket_id = player.read().get_socket_id();
        let username = player.read().get_name().clone();
        let root_msg = match player
            .write()
            .add_chat_message(self.chat_history.clone(), &chat_msg.message)
        {
            ChatResult::Ok(message) => {
                chat_msg.message = message;
                chat_msg.is_admin = auth_info.is_in_game_admin();
                chat_msg.socket_id = socket_id;
                chat_msg.sender = username;
                Some(RootMsg {
                    message: Some(root_msg::Message::UncompressedSm64jsMsg(Sm64JsMsg {
                        message: Some(sm64_js_msg::Message::ChatMsg(chat_msg)),
                    })),
                })
            }
            ChatResult::Err(err) => match err {
                ChatError::Spam => {
                    chat_msg.message =
                            "Chat message ignored: You have to wait longer between sending chat messages"
                                .to_string();
                    chat_msg.sender = "Server".to_string();
                    let root_msg = RootMsg {
                        message: Some(root_msg::Message::UncompressedSm64jsMsg(Sm64JsMsg {
                            message: Some(sm64_js_msg::Message::ChatMsg(chat_msg)),
                        })),
                    };
                    let mut msg = vec![];
                    root_msg.encode(&mut msg).unwrap();

                    return Err(msg);
                }
            },
            ChatResult::NotFound => None,
        };

        Ok(if let Some(root_msg) = root_msg {
            let mut msg = vec![];
            root_msg.encode(&mut msg).unwrap();
            Some(msg)
        } else {
            None
        })
    }

    fn is_name_valid(name: &str) -> bool {
        if name.len() < 3 || name.len() > 14 || name.to_ascii_uppercase() == "SERVER" {
            return false;
        }
        let mut sanitized_name = format!("{}", escape(&name));
        let censor = Censor::Standard;
        sanitized_name = censor.censor(&sanitized_name);
        sanitized_name == name
    }
}
