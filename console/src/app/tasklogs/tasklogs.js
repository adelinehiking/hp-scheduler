import React from 'react';

require('rc-pagination/assets/index.css');
require('rc-select/assets/index.css');
import Pagination from 'rc-pagination';
import Select from 'rc-select';

import request from 'superagent/lib/client';

import TaskLogList from './tasklog_list';

import config from '../config/config';

//TODO: 支持时间范围查询和关键字查询

export default class TaskLogs extends TaskLogList {

    constructor(props, context) {
        super(props, context);

        Object.assign(this.state, {
            height: (window.innerHeight - 300) + 'px',
        });
    }

    handleResize(e) {
        super.handleResize(e);
        this.setState({height: (window.innerHeight - 300) + 'px'});
    }

    _render() {
        var _this = this;

        const pager = (style) => {
            return (
                <div style={{overflow: 'hidden'}}>
                    <div style={style}>
                        <Pagination 
                            showSizeChanger
                            className="ant-pagination"
                            current={this.state.page + 1}
                            defaultCurrent={1}
                            total={this.state.count}
                            pageSize={this.state.pageSize}
                            onChange={this.handlePageChange.bind(this)} 
                            pageSizeOptions={['30', '50', '100', '200']} 
                            selectComponentClass={Select} 
                            onShowSizeChange={this.handleSizeChange.bind(this)} />
                    </div>
                </div>
            );
        }

        return (
            <div>
                {pager({paddingRight: '10px', float:'right'})}
                {super._render()}
                {pager({paddingBottom: '10px', paddingRight: '10px', float:'right'})}
            </div>
        );
    }

    handlePageChange(page) {
        this.setState({
            page: page - 1
        });

        var _this = this;
        setTimeout(function() {
            _this.load();
        }, 0);
    }
    
    handleSizeChange(current, pageSize) {
        this.setState({
            pageSize: pageSize,
            page: 0
        });

        var _this = this;
        setTimeout(function() {
            _this.load();
        }, 0);
    }
    
    _load(cb) {

        var page = this.state.page;
        var per_page = this.state.pageSize;

        request
            .get(config.api_server + '/tasklogs?page=' + page + '&per_page=' + per_page)
            .set('Accept', 'application/json')
            .end(function (err, res) {
                if (err) {
                    cb(err);
                } else {
                    cb(null, res.body);
                }
            });
    }

    load() {
        var _this = this;

        _this.showLoading();

        this._load(function (err, data) {

            _this.hideLoading();

            if (err) {
                _this.showAlert('提示', '加载任务日志列表失败', '重新加载', function() {
                    setTimeout(function(){
                        _this.load();
                    }, 0);
                });
            } else {
                _this.setState({
                    data: data.data.data,
                    count: data.data.count
                });
            }
        });
    }
}
