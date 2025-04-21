import requests
from typing import Dict, Any, Optional
import json
import time
import string
import random
import logging
import re

# 配置日志记录
logging.basicConfig(level=logging.DEBUG)
logger = logging.getLogger(__name__)

class CozeHandler:
    def __init__(self, api_key: str, bot_id: str):
        self.api_key = api_key
        self.bot_id = bot_id
        self.base_url = 'https://api.coze.cn/open_api/v2/chat'
        self.headers = {
            'Authorization': f'Bearer {api_key}',
            'Content-Type': 'application/json'
        }
        self.connection_tested = False
        self.connection_ok = False
        logger.info(f"初始化 CozeHandler: bot_id={bot_id}, api_key={api_key[:8]}...")
        
        # 在初始化时测试连接
        if self._test_connection():
            self.connection_tested = True
            self.connection_ok = True
            logger.info("API 连接测试成功")
        else:
            logger.error("API 连接测试失败")
            raise Exception("无法连接到 Coze API，请检查网络连接和 API 配置")

    def _normalize_passport_data(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """规范化护照数据"""
        if not data:
            return data

        # 1. 规范化拼音姓名中的字符
        if 'surname' in data:
            # 将数字0替换为字母O
            data['surname'] = data['surname'].replace('0', 'O')
            # 将数字1替换为字母I
            data['surname'] = data['surname'].replace('1', 'I')
            # 确保全部大写
            data['surname'] = data['surname'].upper()

        if 'given_name' in data:
            # 将数字0替换为字母O
            data['given_name'] = data['given_name'].replace('0', 'O')
            # 将数字1替换为字母I
            data['given_name'] = data['given_name'].replace('1', 'I')
            # 确保全部大写
            data['given_name'] = data['given_name'].upper()

        # 2. 规范化护照号码
        if 'passport_number' in data and data['passport_number']:
            passport_num = data['passport_number']
            if len(passport_num) >= 9:  # 标准护照号长度
                # 前两位应该是字母
                prefix = passport_num[:2].upper()
                # 将前两位中的数字0替换为字母O
                prefix = prefix.replace('0', 'O')
                # 将前两位中的数字1替换为字母I
                prefix = prefix.replace('1', 'I')
                
                # 后七位应该是数字
                numbers = passport_num[2:]
                # 将字母O替换为数字0
                numbers = numbers.replace('O', '0')
                # 将字母I或l替换为数字1
                numbers = re.sub('[Il]', '1', numbers)
                
                # 组合新的护照号
                data['passport_number'] = prefix + numbers

        # 3. 规范化性别
        if 'gender' in data:
            # 确保性别只能是 'M' 或 'F'
            gender = data['gender'].upper()
            if gender not in ['M', 'F']:
                # 如果是其他值，尝试智能转换
                if gender in ['0', 'O']:
                    gender = 'F'  # 假设0或O可能是F的错误识别
                elif gender in ['1', 'I', 'L']:
                    gender = 'M'  # 假设1、I或L可能是M的错误识别
            data['gender'] = gender

        # 4. 规范化日期格式
        date_fields = ['birth_date', 'expiry_date']
        for field in date_fields:
            if field in data and data[field]:
                # 移除所有非数字字符
                date_str = re.sub(r'\D', '', data[field])
                # 确保日期长度为8位
                if len(date_str) == 8:
                    data[field] = date_str

        return data

    def _generate_user_id(self) -> str:
        """生成随机user_id"""
        chars = string.ascii_letters + string.digits
        return ''.join(random.choice(chars) for _ in range(16))

    def _test_connection(self) -> bool:
        """测试 API 连接"""
        try:
            logger.debug(f"测试 API 连接: {self.base_url}")
            
            # 构建一个简单的测试请求
            request_data = {
                'conversation_id': f'test_{int(time.time())}',
                'bot_id': self.bot_id,
                'user': self._generate_user_id(),
                'query': 'test connection',
                'stream': False
            }
            
            response = requests.post(
                self.base_url,
                headers=self.headers,
                json=request_data,
                timeout=10
            )
            
            if response.status_code == 200:
                response_json = response.json()
                return response_json.get('code') == 0
            return False
                
        except Exception as e:
            logger.error(f"API 连接测试失败: {str(e)}", exc_info=True)
            return False

    def process_passport_text(self, text: str) -> Optional[Dict[str, Any]]:
        """处理护照文本并获取结构化数据"""
        if not self.connection_ok:
            raise Exception("API 连接未就绪")
            
        try:
            logger.info("开始处理护照文本...")
            # 构建请求数据
            request_data = {
                'conversation_id': f'conv_{int(time.time())}',
                'bot_id': self.bot_id,
                'user': self._generate_user_id(),
                'query': text,  # 只传入文本内容，不包含提示词
                'stream': False
            }

            logger.debug(f"发送护照文本处理请求，文本长度: {len(text)}")
            
            # 发送请求
            response = requests.post(
                self.base_url,
                headers=self.headers,
                json=request_data,
                timeout=30
            )
            
            logger.debug(f"收到护照处理响应: 状态码={response.status_code}")
            
            if response.status_code != 200:
                logger.error(f"API 请求失败: {response.status_code} - {response.text}")
                raise Exception(f"API 请求失败: {response.status_code}")

            response_json = response.json()
            
            if response_json.get('code') != 0:
                logger.error(f"API 返回错误: {response_json}")
                raise Exception(f"API 返回错误: {response_json.get('message')}")

            # 处理返回的消息
            messages = response_json.get('messages', [])
            for message in messages:
                if (message.get('role') == 'assistant' and 
                    message.get('type') == 'answer' and 
                    message.get('content_type') == 'text'):
                    content = message.get('content')
                    if content:
                        try:
                            # 尝试解析返回的 JSON 字符串
                            # 移除可能的 Markdown 代码块标记
                            content = content.strip()
                            if content.startswith('```json'):
                                content = content[7:]
                            if content.startswith('```'):
                                content = content[3:]
                            if content.endswith('```'):
                                content = content[:-3]
                                
                            logger.debug(f"清理后的内容: {content}")
                            raw_data = json.loads(content.strip())
                            
                            # 转换字段名
                            passport_data = {
                                'passport_number': raw_data.get('护照号码'),
                                'surname': raw_data.get('拼音姓'),
                                'given_name': raw_data.get('拼音名'),
                                'gender': raw_data.get('性别'),
                                'birth_date': raw_data.get('出生日期'),
                                'expiry_date': raw_data.get('护照到期日'),
                                'chinese_name': raw_data.get('中文姓名')
                            }
                            
                            # 规范化处理数据
                            passport_data = self._normalize_passport_data(passport_data)
                            
                            logger.info(f"成功解析护照数据: {passport_data}")
                            return passport_data
                        except json.JSONDecodeError as e:
                            logger.error(f"JSON 解析失败: {str(e)}, 内容: {content}")
                            raise Exception(f"无法解析 API 返回的数据: {str(e)}")

            raise Exception("API 返回数据中没有找到有效的护照信息")
            
        except Exception as e:
            logger.error(f"处理护照文本失败: {str(e)}", exc_info=True)
            raise Exception(f"处理护照文本失败: {str(e)}")

    def validate_response(self, response: Dict[str, Any]) -> bool:
        """验证响应数据的完整性"""
        # 必需字段
        required_fields = [
            'passport_number', 
            'surname', 
            'given_name', 
            'gender', 
            'birth_date', 
            'expiry_date'
        ]
        
        # 检查所有必需字段是否存在且不为空
        for field in required_fields:
            if not response.get(field):
                logger.warning(f"缺少必需字段或字段为空: {field}")
                return False
                
        # 验证日期格式
        date_fields = ['birth_date', 'expiry_date']
        for field in date_fields:
            date_str = response.get(field, '')
            if not (len(date_str) == 8 and date_str.isdigit()):
                logger.warning(f"日期格式不正确: {field}={date_str}")
                return False
                
        # 验证性别
        gender = response.get('gender')
        if gender not in ['M', 'F']:
            logger.warning(f"性别格式不正确: {gender}")
            return False
            
        # 中文姓名是可选字段，不需要验证
        
        logger.info(f"响应数据验证通过")
        return True 