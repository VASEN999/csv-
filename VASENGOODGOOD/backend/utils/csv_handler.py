import pandas as pd
import os
from typing import Dict, List, Any
import numpy as np
import json
import logging
import hashlib

class CSVHandler:
    def __init__(self, file_path: str, cache=None):
        self.file_path = file_path
        self.data = None
        self.photo_filename_map = {}  # 添加文件名映射字典
        self.cache = cache  # 缓存对象
        self.file_hash = None  # 文件哈希值
        
        # 计算文件哈希
        self._calculate_file_hash()
        
        # 从缓存加载或处理CSV
        self._load_or_process_csv()

    def _calculate_file_hash(self) -> None:
        """计算文件的 SHA-256 哈希值"""
        try:
            sha256_hash = hashlib.sha256()
            with open(self.file_path, "rb") as f:
                # 读取前1MB进行哈希计算
                data = f.read(1024 * 1024)
                if data:
                    sha256_hash.update(data)
            self.file_hash = sha256_hash.hexdigest()
            logging.info(f"CSV文件哈希值: {self.file_hash}")
        except Exception as e:
            logging.error(f"计算CSV文件哈希值失败: {str(e)}")
            raise

    def _get_cache_key(self) -> str:
        """获取缓存键"""
        return f"csv_data_{self.file_hash}"

    def _get_file_cache_path(self) -> str:
        """获取文件缓存路径"""
        # 获取 uploads 目录
        uploads_dir = os.path.dirname(os.path.dirname(self.file_path))
        # 创建 cache 目录
        cache_dir = os.path.join(uploads_dir, 'cache')
        os.makedirs(cache_dir, exist_ok=True)
        return os.path.join(cache_dir, f"{self.file_hash}_csv.json")

    def _load_or_process_csv(self) -> None:
        """从缓存加载或处理CSV文件"""
        # 如果有缓存对象，尝试从缓存加载
        if self.cache:
            cache_key = self._get_cache_key()
            cached_data = self.cache.get(cache_key)
            if cached_data:
                logging.info(f"从内存缓存加载CSV数据: {cache_key}")
                # 重构DataFrame
                self.data = pd.DataFrame(cached_data['data'])
                self.photo_filename_map = cached_data['photo_filename_map']
                return

        # 如果没有内存缓存，尝试从文件缓存加载
        file_cache_path = self._get_file_cache_path()
        if os.path.exists(file_cache_path):
            try:
                with open(file_cache_path, 'r', encoding='utf-8') as f:
                    cached_data = json.load(f)
                    # 重构DataFrame
                    self.data = pd.DataFrame(cached_data['data'])
                    self.photo_filename_map = cached_data['photo_filename_map']
                    logging.info(f"从文件缓存加载CSV数据: {file_cache_path}")
                    
                    # 将文件缓存同步到内存缓存
                    if self.cache:
                        self.cache.set(self._get_cache_key(), cached_data)
                    return
            except Exception as e:
                logging.warning(f"从文件缓存加载CSV失败: {str(e)}")

        # 如果没有缓存或加载失败，处理CSV
        self.load_csv()
        
        # 将处理结果保存到缓存
        if self.data is not None:
            # 准备缓存数据
            cache_data = {
                'data': self.data.to_dict('records'),
                'photo_filename_map': self.photo_filename_map,
                'processed_time': pd.Timestamp.now().strftime('%Y-%m-%d %H:%M:%S')
            }
            
            # 保存到内存缓存
            if self.cache:
                self.cache.set(self._get_cache_key(), cache_data)
            
            # 保存到文件缓存
            try:
                with open(file_cache_path, 'w', encoding='utf-8') as f:
                    json.dump(cache_data, f, ensure_ascii=False)
                logging.info(f"CSV数据已缓存到文件: {file_cache_path}")
            except Exception as e:
                logging.error(f"保存CSV缓存到文件失败: {str(e)}")

    def load_csv(self) -> None:
        """加载 CSV 文件"""
        try:
            # 设置列名
            columns = [
                'index', 'valid', 'passport_number', 'expiry_date',
                'surname', 'given_name', 'gender', 'birth_date',
                'nationality', 'unused1', 'unused2', 'unused3',
                'unused4', 'photo_filename', 'batch_number', 'unused5',
                'type', 'duration', 'category', 'validity',
                'unused6', 'unused7', 'chinese_name'
            ]
            
            # 读取 CSV 文件
            self.data = pd.read_csv(self.file_path, header=None, names=columns)
            
            # 替换所有的 NaN 值为 None
            self.data = self.data.replace({np.nan: None})
            
            # 确保日期格式统一
            self.data['birth_date'] = self.data['birth_date'].apply(
                lambda x: str(x).zfill(8) if pd.notna(x) else None
            )
            self.data['expiry_date'] = self.data['expiry_date'].apply(
                lambda x: str(x).zfill(8) if pd.notna(x) else None
            )
            
            # 更新照片文件名映射
            self._update_photo_filename_map()
            
            # 打印调试信息
            logging.info(f"CSV 列名: {self.data.columns.tolist()}")
            logging.info(f"第一行数据: {self.data.iloc[0].to_dict()}")
            
        except Exception as e:
            logging.error(f"CSV 加载错误: {str(e)}")
            raise Exception(f"无法加载 CSV 文件: {str(e)}")

    def _update_photo_filename_map(self):
        """更新照片文件名映射"""
        try:
            # 获取照片目录
            photos_dir = os.path.join(os.path.dirname(os.path.dirname(self.file_path)), 'uploads', 'photos')
            if not os.path.exists(photos_dir):
                logging.warning(f"照片目录不存在: {photos_dir}")
                return

            # 获取目录中的所有文件
            files = os.listdir(photos_dir)
            
            # 为每个 CSV 中的文件名找到对应的实际文件名
            for _, row in self.data.iterrows():
                if pd.isna(row['photo_filename']):
                    continue
                    
                base_filename = str(row['photo_filename']).strip()
                if not base_filename:
                    continue

                # 查找匹配的文件
                for file in files:
                    if base_filename in file:
                        self.photo_filename_map[base_filename] = file
                        logging.debug(f"找到文件名映射: {base_filename} -> {file}")
                        break

            logging.info(f"已建立 {len(self.photo_filename_map)} 个文件名映射")
        except Exception as e:
            logging.error(f"更新文件名映射时出错: {str(e)}")

    def to_json(self) -> List[Dict[str, Any]]:
        """将 CSV 数据转换为 JSON 格式"""
        if self.data is None:
            return []
        
        # 将数据转换为字典列表
        records = []
        for _, row in self.data.iterrows():
            photo_filename = str(row['photo_filename']) if pd.notna(row['photo_filename']) else ''
            # 使用映射获取实际的文件名
            actual_filename = self.photo_filename_map.get(photo_filename, photo_filename)
            
            record = {
                'index': str(row['index']) if pd.notna(row['index']) else '',
                'passport_number': str(row['passport_number']) if pd.notna(row['passport_number']) else '',
                'surname': str(row['surname']) if pd.notna(row['surname']) else '',
                'given_name': str(row['given_name']) if pd.notna(row['given_name']) else '',
                'gender': str(row['gender']) if pd.notna(row['gender']) else '',
                'birth_date': str(row['birth_date']) if pd.notna(row['birth_date']) else '',
                'expiry_date': str(row['expiry_date']) if pd.notna(row['expiry_date']) else '',
                'photo_filename': actual_filename,
                'chinese_name': str(row['chinese_name']) if pd.notna(row.get('chinese_name')) else '',
                'team_acceptance_number': str(row['batch_number']) if pd.notna(row.get('batch_number')) else ''
            }
            
            # 清理数据中的 'nan' 字符串
            for key, value in record.items():
                if value.lower() == 'nan':
                    record[key] = ''
                
            # 确保日期格式正确
            for date_field in ['birth_date', 'expiry_date']:
                if record[date_field]:
                    record[date_field] = record[date_field].zfill(8)
            
            records.append(record)
            
        # 打印调试信息
        if records:
            logging.info(f"转换后的第一条记录: {json.dumps(records[0], ensure_ascii=False)}")
        else:
            logging.warning("没有记录被转换")
        
        return records

    def get_record_by_passport(self, passport_number: str) -> Dict[str, Any]:
        """根据护照号码获取记录"""
        if self.data is None:
            return None
        
        record = self.data[self.data['passport_number'] == passport_number]
        if record.empty:
            return None
        
        # 确保返回的数据不包含 NaN
        return record.iloc[0].replace({np.nan: None}).to_dict()

    def get_photo_path(self, record_index: int) -> str:
        """获取证件照路径"""
        if self.data is None or record_index >= len(self.data):
            return None
        
        return self.data.iloc[record_index]['photo_filename']

    def compare_with_passport_data(self, record_index: int, passport_data: Dict[str, Any]) -> Dict[str, List[str]]:
        """比较 CSV 记录与护照数据"""
        if self.data is None or record_index >= len(self.data):
            return None

        record = self.data.iloc[record_index]
        discrepancies = {
            'errors': [],
            'warnings': []
        }

        # 比较关键字段
        fields_to_compare = {
            'passport_number': '护照号码',
            'surname': '姓',
            'given_name': '名',
            'gender': '性别',
            'birth_date': '出生日期',
            'expiry_date': '护照到期日'
        }

        for csv_field, display_name in fields_to_compare.items():
            csv_value = None
            if pd.isna(record[csv_field]):
                csv_value = None
            passport_value = passport_data.get(csv_field)
            
            if csv_value and passport_value and str(csv_value).strip() != str(passport_value).strip():
                discrepancies['errors'].append(
                    f"{display_name}不匹配: CSV={csv_value}, 护照={passport_value}"
                )

        return discrepancies 