var schedule = require('node-schedule');
var parser = require('cron-parser');

// DB Models
var Triggers = require('../models/triggers');
var TaskLogs = require('../models/tasklogs');
var Tasks = require('../models/tasks');
var TaskRecords = require('../models/taskrecords');

var moment = require('moment');

// MQ
var MQ = require('./mq');

// LIB
var db = require('./db');
var Log = require('./log');

var config = require('../config/config');

function scheduler() {
    if (!(this instanceof scheduler)) {
        return new TaskCenter();
    }
    
    var _this = this;

    this.triggers = {};

    this.initTriggers = function() {
        return Triggers.model()
            .findAll()
            .then(function cb_triggerList(data){
                var ret = [];
                for (var i=0;i<data.length;i++) {
                    var p = new Promise(function addTrigger(resolve, reject){
                        try {
                            _this.add(data[i]);
                            resolve();
                        } catch (e) {
                            reject(e);
                        }
                    });
                    ret.push(p);
                }

                return Promise.all(ret);
            })
            .catch(function cb_initTrigers_error(err){
                Log.e(err);
                process.exit(1);
            });
    }

    this.init = function() {

        // var i = 0;
        // setInterval(function(){
        //     if (i > 100) return;            
        //     MQ.send("demo", [JSON.stringify({
        //         taskid: '41b572eb-b221-4dc0-9da9-7ff91c5c3824' + (i++)
        //     })]);
        // }, 3000);

        // scheduler.add({
        //     id: "",
        //     name: "轮询间隔5分钟触发",
        //     code: "AXV0B1A5",
        //     stime: 0,
        //     etime: 0,
        //     //TODO: v0.0.2 重复次数
        //     //repeat: 0,
        //     type: 1,
        //     value: "*/3 * * * * *"
        // });

        var _this = this;
        
        Triggers.define();
        Tasks.define();
        TaskLogs.define();
        TaskRecords.define();
        db.sync({force: false})
            .then(function cb_db_sync(){
                
                //启动定时器，定时清理数据库数据
                _this.startClearTimer();

                _this.listenLogs();

                return _this.initTriggers();
            })
            .catch(function cb_db_sync_error(err){
                Log.e('初始化失败', err);
            })
            .done();

    },

    this.startClearTimer = function() {
        this.clearData();

        var _this = this;
        setInterval(function(){
            _this.clearData();
        }, 3600 * 1000); //1小时执行依此
    },

    this.clearData = function() {

        var filter = {
            where: {
                createdAt: {
                    $lt: moment().hour(0).minute(0).second(0).subtract("days", config.max_backlog || 7).toDate()
                }
            }
        }

        TaskLogs.model().destroy(filter).then(function(){
            Log.d('清理tasklogs完成');
        }).catch(function(err){
            Log.e('清理tasklogs失败', err);
        });
        TaskRecords.model().destroy(filter).then(function(){
            Log.d('清理taskrecords完成');
        }).catch(function(err){
            Log.e('清理taskrecords失败', err);
        });
    },

    this.listenLogs = function() {

        MQ.recv(config.dispatcher_center_callback, function(mq_msg) {
            
            var data = null;
            var msg = mq_msg.message;
            try { data = JSON.parse(msg);} catch(err) {
                Log.e("收到任务日志格式错误:", err);
                return;
            }

            if (!data.task_id || !data.time) {
                Log.e('日志参数错误:' + msg);
                return;
            }

            var taskid = data.task_id;

            var log = {
                taskrecord_id: data.task_id,
                time: data.time,
                message: data.message,
                progress: data.progress
            };

            // 写入TaskLogs
            TaskLogs.model().create(log)
                .then(function cb_create_tasklog(data){
                })
                .catch(function cb_create_tasklog_error(err){
                    Log.f('写入日志数据失败:' + JSON.stringify(log), err);
                })
                .done();
                
            var TaskRecordModel = TaskRecords.model();
            TaskRecordModel.findById(taskid)
                .then(function cb_findById_taskrecord(data){

                    var item = {
                        stime: log.time,
                        etime: log.time,
                        progress: log.progress,
                    };

                    if (item.progress) {
                        if (item.progress < 0) {
                            item.progress = -1;
                        } else if (item.progress > 100) {
                            item.progress = 100;
                        }
                    }
                    
                    if (item.progress === -1) {
                        item.status = 3;
                    } else if (item.progress === 100) {
                        item.status = 2;
                    } else {
                        item.status = 1;
                    }

                    if (item.progress == -1) {
                        delete item.progress;
                    }

                    if (data) {

                        if (data.stime) {
                            delete item.stime;
                        }

                        //日志顺序颠倒，忽略
                        
                        if (data.status === 2 || data.status === 3 || data.status === 4) {
                            Log.w('日志顺序颠倒，忽略(A):::' + JSON.stringify(log));
                            return;
                        }

                        if (data.etime && data.etime > log.time) {
                            Log.w('日志顺序颠倒，忽略(B):::' + JSON.stringify(log)); 
                            return;
                        }
                        
                        if (data.progress && log.progress && log.progress != -1 && data.progress > log.progress) {
                            Log.w('日志顺序颠倒，忽略(C):::' + JSON.stringify(log));
                            return;
                        }
                    }

                    // 更新任务记录状态
                    return TaskRecordModel.update(item, {where: {id: taskid}});
                })
                .then(function cb_ack(data){
                    mq_msg.ack();
                })
                .catch(function cb_taskrecord_error(err){
                    Log.f("更新任务记录状态失败", err);
                    mq_msg.nack();
                }).done();
        });
    }

    this.update = function(trigger) {
        if (!this.validate(trigger))
            return;
        
        var item = this.triggers["trigger_" + trigger.id];
        if (!item) {
            Log.e(new Error("错误提示: trigger not fount"));
            return;
        }

        this.unschedule(trigger);
        item.trigger = trigger;
        //TODO: v0.0.2 重复次数
        //item.repeated = 0;
        item.schedule = this.schedule(trigger);
        item.live = (item.schedule != null);
    }

    this.add = function(trigger) {
        if (!this.validate(trigger))
            return;
        
        var item = this.triggers[ "trigger_" + trigger.id];
        if (item) {
            Log.e(new Error("错误提示: trigger not fount"));
            return;
        }

        var item = {
            trigger: trigger,
            schedule: this.schedule(trigger),
            //TODO: v0.0.2 重复次数
            //repeated: 0
        };

        item.live = (item.schedule != null);

        this.triggers["trigger_" + trigger.id] = item;
    },

    this.remove = function(trigger) {
        this.unschedule(trigger);
        var item = this.triggers["trigger_" + trigger.id];
        if (item) {
            delete item;
        } 
    },

    this.validate = function(trigger) {
        if (trigger.type == 0) {
            try {
                var interval = parseInt(trigger.value);
            } catch (error) {
                return false;
            }
        } else {
            try {
                var interval = parser.parseExpression(trigger.value);
            } catch (error) {
                return false;
            }
        }
        return true;
    }

    this.schedule = function(trigger) {

        var _this = this;

        var ret = _this.expired(trigger);
        if (ret > 0) {
            return null;
        }
        
        var looper = {};

        if (trigger.type == 0) {                // --- Interval
            //根据开始时间设置setTimeout时间参数
            var t = 0;
            if (trigger.stime > 0) {
                var now = new Date().getTime();
                if (now < trigger.stime) {
                    t = trigger.stime - now;
                }
            }

            looper.timeout = setTimeout(function task_timeout(){
                looper.timeout = 0;

                ret = _this.expired(trigger);
                if (ret > 0) {
                    _this.unschedule(trigger);
                } else {
                    if (ret == 0) {
                        _this.trigger_tasks(trigger);
                    }
                    looper.interval = setInterval(function task_interval(){

                        ret = _this.expired(trigger);

                        if (ret == 0) {
                            _this.trigger_tasks(trigger);
                        } else if (ret > 0) {
                            _this.unschedule(trigger);
                        } else {
                            //waiting
                        }
                    }, parseInt(trigger.value) * 1000);
                }
            }, t);

        } else /* if (trigger.type == 0) */ {   // --- Cron
            
            looper.timeout = setTimeout(function task_timeout(){
                looper.timeout = 0;

                looper.job = schedule.scheduleJob(trigger.value, function task_schedule() {
                    if (!_this.expired(trigger)) {
                        _this.trigger_tasks(trigger);
                    } else {
                        _this.unschedule(trigger);
                    }
                });
            }, 0);
        }

        return looper;
    }

    this.unschedule = function(trigger) {
        var item = this.triggers["trigger_" + trigger.id];
        if (!item) {
            Log.e(new Error("错误提示: trigger not fount"));
            return;
        }

        if (item.schedule) {
            if (item.schedule.job) {
                item.schedule.job.cancel();
            }
            if (item.schedule.timeout) {
                clearTimeout(item.schedule.timeout);
            }
            if (item.schedule.interval) {
                clearInterval(item.schedule.interval);
            }
        }
        item.live = false;
    }

    this.trigger_tasks = function(trigger) {
        var _this = this;

        var item = this.triggers["trigger_" + trigger.id];
        if (!item) {
            Log.e(new Error("错误提示: trigger not fount"));
            return;
        }

        //TODO: v0.0.2 重复次数
        //item.repeated = item.repeated || 0;
        //item.repeated ++;

        //读取数据库任务触发任务
        Tasks.model()
            .findAll({
                where: {
                    trigger_code: trigger.code
                }
            })
            .then(function cb_findAll_task(data){
                if (data.length > 0) {
                    var ret = []
                    for (var i=0;i<data.length;i++) {
                        ret.push(_this.run(data[i]));
                    }
                    return Promise.all(ret);
                }
                else {
                    Log.d("SCHEDULER:::EMPTY::: " + JSON.stringify(trigger));
                }
            })
            .catch(function cb_findAll_task_error(err){
                Log.e("执行触发器任务失败(获取任务列表失败):" + trigger.code, err);
            })
            .done();
    }

    //=0 可以执行
    //<0 待执行
    //>0 已执行完
    this.expired = function(trigger) {
        var now = new Date().getTime();

        if (trigger.stime != 0) {
            if (now < trigger.stime)
                return -1;
        }
        if (trigger.etime != 0) {
            if (now > trigger.etime)
                return 1;
        }
        /*
        //TODO: v0.0.2 重复次数
        if (trigger.repeat != 0) {
            var item = this.triggers["trigger_" + trigger.id];
            if (item && item.repeated >= trigger.repeat)
                return 1;
        }
        */
        return 0;
    }

    this.run = function(task) {
        //Log.i("SCHEDULER::: " + JSON.stringify(task)); return ;
        
        // 重复任务不要重复触发

        var data = {
            task_id: task.id,
            name: task.name,
            detail: task.detail || '',
            param: task.param || '',
            trigger_code: task.trigger_code,
            type: task.type,
            target: task.target
        }

        var id;

        var item = {
            target: task.target,
            param: data.param,
            status: 0
        };

        var TaskRecordModel = TaskRecords.model();

        return TaskRecordModel.count({
            where: item
        }).then(function cb_getCount(cnt){
            if (cnt !== 0) {
                return Promise.reject(new Error('相同任务不要重复触发'));
            }

            // 插入一条任务记录
            return TaskRecordModel.create(data)
            
        }).then(function cb_created(data){

            id = data.id;

            // 发送消息到MQ
            return MQ.send(task.target, JSON.stringify({
                task_id: data.id,
                param: data.param
            }))

        }).then(function cb_send(){

            Log.i('发送任务消息成功:' + task.name);

        }).catch(function cb_error(err){

            Log.f("触发任务失败:" + task.name + err.message);

            if (id) {
                TaskRecordModel
                    .destroy({where: { id: id }})
                    .then(null).done();
            }  
        }).done();
    }
}

//TODO: v0.0.2 重复次数
//1. Task需增加repeat，且需更新repeat字段
//2. 考虑repeat到达上线后，如何重置

module.exports = new scheduler();
